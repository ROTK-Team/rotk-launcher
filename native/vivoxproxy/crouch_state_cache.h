#ifndef ROTK_CROUCH_STATE_CACHE_H
#define ROTK_CROUCH_STATE_CACHE_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/*
 * A Solo process can retain animation networks from the login/lobby handoff
 * while evaluating every player in a full match. Keep enough headroom for
 * several 50-player generations without allocating from the animation hook.
 */
#define CROUCH_STATE_CAPACITY 256U
#define CROUCH_STATE_STALE_SECONDS 2.0

typedef struct crouch_transition_state {
    void *network;
    uintptr_t generation;
    uintptr_t control_generation;
    float last_raw;
    float last_control;
    float last_output;
    float start_output;
    float target;
    double duration_seconds;
    int64_t start_counter;
    int64_t transition_end_counter;
    int64_t last_move_counter;
    int64_t last_seen_counter;
    int64_t last_call_sequence;
    int initialized;
    int transitioning;
    int move_seen;
} crouch_transition_state;

typedef enum crouch_state_cache_event {
    CROUCH_STATE_CACHE_HIT = 0,
    CROUCH_STATE_CACHE_INSERTED = 1,
    CROUCH_STATE_CACHE_STALE_RESET = 2,
    CROUCH_STATE_CACHE_GENERATION_RESET = 3,
    CROUCH_STATE_CACHE_EVICTED = 4,
    CROUCH_STATE_CACHE_OUT_OF_ORDER = 5,
    CROUCH_STATE_CACHE_PRESSURE = 6
} crouch_state_cache_event;

typedef struct crouch_state_cache_lookup {
    crouch_state_cache_event event;
    void *previous_network;
    uintptr_t previous_generation;
    uintptr_t previous_control_generation;
} crouch_state_cache_lookup;

static int crouch_state_cache_is_active(
    const crouch_transition_state *state,
    int64_t now_counter) {
    return state->transitioning &&
        state->transition_end_counter > now_counter;
}

static int crouch_state_cache_is_stale(
    const crouch_transition_state *state,
    int64_t now_counter,
    int64_t stale_after_ticks) {
    return now_counter > state->last_seen_counter &&
        now_counter - state->last_seen_counter > stale_after_ticks;
}

static void crouch_state_cache_reset(
    crouch_transition_state *state,
    void *network,
    uintptr_t generation,
    uintptr_t control_generation,
    int64_t now_counter,
    int64_t call_sequence) {
    memset(state, 0, sizeof(*state));
    state->network = network;
    state->generation = generation;
    state->control_generation = control_generation;
    state->last_seen_counter = now_counter;
    state->last_call_sequence = call_sequence;
}

/*
 * Resolve one animation network without heap allocation.
 *
 * `network + generation + control_generation` identifies an exact live
 * Morpheme Network. The generation values are Network::m_nodeBins and the
 * crouch control pin-entry array; together they prevent recycled addresses
 * from inheriting another actor's transition. A full cache may evict only the
 * least-recently-seen stale entry whose transition has actually expired. If
 * no such entry exists, the caller fails open to the stock graph rather than
 * interrupting an existing player's blend.
 *
 * The caller serializes this function and every mutation of the returned
 * state with the same lock.
 */
static crouch_transition_state *crouch_state_cache_acquire(
    crouch_transition_state *states,
    size_t capacity,
    void *network,
    uintptr_t generation,
    uintptr_t control_generation,
    int64_t now_counter,
    int64_t stale_after_ticks,
    int64_t call_sequence,
    crouch_state_cache_lookup *lookup) {
    size_t index;
    crouch_transition_state *empty = NULL;
    crouch_transition_state *oldest_stale = NULL;
    crouch_transition_state *selected;

    if (lookup != NULL) {
        lookup->event = CROUCH_STATE_CACHE_PRESSURE;
        lookup->previous_network = NULL;
        lookup->previous_generation = 0U;
        lookup->previous_control_generation = 0U;
    }
    if (states == NULL || capacity == 0U || network == NULL ||
        generation == 0U || control_generation == 0U ||
        stale_after_ticks < 0 || call_sequence <= 0) {
        return NULL;
    }

    for (index = 0U; index < capacity; ++index) {
        crouch_transition_state *candidate = &states[index];

        if (candidate->network == network) {
            crouch_state_cache_event reset_event;

            if (call_sequence <= candidate->last_call_sequence) {
                if (lookup != NULL) {
                    lookup->event = CROUCH_STATE_CACHE_OUT_OF_ORDER;
                    lookup->previous_network = candidate->network;
                    lookup->previous_generation = candidate->generation;
                    lookup->previous_control_generation =
                        candidate->control_generation;
                }
                return NULL;
            }

            if (candidate->generation != generation ||
                candidate->control_generation != control_generation) {
                reset_event = CROUCH_STATE_CACHE_GENERATION_RESET;
            } else if (
                crouch_state_cache_is_stale(
                    candidate,
                    now_counter,
                    stale_after_ticks) &&
                !crouch_state_cache_is_active(candidate, now_counter)) {
                reset_event = CROUCH_STATE_CACHE_STALE_RESET;
            } else {
                if (now_counter > candidate->last_seen_counter) {
                    candidate->last_seen_counter = now_counter;
                }
                candidate->last_call_sequence = call_sequence;
                if (lookup != NULL) {
                    lookup->event = CROUCH_STATE_CACHE_HIT;
                }
                return candidate;
            }

            if (lookup != NULL) {
                lookup->event = reset_event;
                lookup->previous_network = candidate->network;
                lookup->previous_generation = candidate->generation;
                lookup->previous_control_generation =
                    candidate->control_generation;
            }
            crouch_state_cache_reset(
                candidate,
                network,
                generation,
                control_generation,
                now_counter,
                call_sequence);
            return candidate;
        }
        if (candidate->network == NULL) {
            if (empty == NULL) {
                empty = candidate;
            }
            continue;
        }
        if (crouch_state_cache_is_stale(
                candidate,
                now_counter,
                stale_after_ticks) &&
            !crouch_state_cache_is_active(candidate, now_counter) &&
            (oldest_stale == NULL ||
             candidate->last_seen_counter < oldest_stale->last_seen_counter)) {
            oldest_stale = candidate;
        }
    }

    selected = empty != NULL ? empty : oldest_stale;
    if (selected == NULL) {
        return NULL;
    }
    if (lookup != NULL) {
        lookup->event = empty != NULL
            ? CROUCH_STATE_CACHE_INSERTED
            : CROUCH_STATE_CACHE_EVICTED;
        lookup->previous_network = selected->network;
        lookup->previous_generation = selected->generation;
        lookup->previous_control_generation = selected->control_generation;
    }
    crouch_state_cache_reset(
        selected,
        network,
        generation,
        control_generation,
        now_counter,
        call_sequence);
    return selected;
}

/* Hint only: the state identity is still checked by acquire under the same
 * lock. Collisions and evictions fall back to the existing bounded scan. */
static crouch_transition_state *crouch_state_cache_acquire_hint(
    crouch_transition_state *states, size_t capacity, size_t *hints, size_t hint_count,
    void *network, uintptr_t generation, uintptr_t control_generation,
    int64_t now, int64_t stale, int64_t sequence, crouch_state_cache_lookup *lookup) {
    uintptr_t key = (uintptr_t)network;
    size_t bucket = ((key >> 4U) ^ (key >> 16U)) % hint_count;
    size_t index = hints[bucket];
    if (index < capacity && states[index].network == network && network != NULL) {
        return crouch_state_cache_acquire(states + index, 1U, network,
            generation, control_generation, now, stale, sequence, lookup);
    }
    crouch_transition_state *state = crouch_state_cache_acquire(states, capacity,
        network, generation, control_generation, now, stale, sequence, lookup);
    if (state != NULL) hints[bucket] = (size_t)(state - states);
    return state;
}

#endif
