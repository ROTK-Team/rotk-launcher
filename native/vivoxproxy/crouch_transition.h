#ifndef ROTK_CROUCH_TRANSITION_H
#define ROTK_CROUCH_TRANSITION_H

#include <math.h>
#include "crouch_state_cache.h"

#define CROUCH_IDLE_ENTER_SECONDS 0.4000000059604645
#define CROUCH_IDLE_EXIT_SECONDS 0.20000000298023224
#define CROUCH_MOVE_SECONDS 0.25
#define CROUCH_MOVE_RECENT_SECONDS 0.10000000149011612

/* Keep the existing 100 ms moving-node grace period, then fade its influence
 * over another 100 ms. Integrating this weight makes the phase independent of
 * evaluation cadence and removes the old 100/101 ms duration discontinuity. */
static double crouch_move_area(double age) {
    const double grace = CROUCH_MOVE_RECENT_SECONDS;
    if (age <= 0.0) return 0.0;
    if (age <= grace) return age;
    if (age >= 2.0 * grace) return 1.5 * grace;
    age -= grace;
    return grace + age - age * age / (2.0 * grace);
}

static double crouch_idle_seconds(float target) {
    return target > 0.5f ? CROUCH_IDLE_ENTER_SECONDS : CROUCH_IDLE_EXIT_SECONDS;
}

/* Only call while holding the network state lock. Observe a moving node AFTER
 * evaluating the elapsed interval: a newly observed node cannot rewrite the
 * past. Multiple nodes at the same timestamp therefore share the same pose. */
static float crouch_transition_evaluate(
    crouch_transition_state *state, int64_t now, int64_t frequency,
    int *completed) {
    double elapsed, moving_area = 0.0, distance, idle;
    *completed = 0;
    if (!state->transitioning) return state->target;
    if (now <= state->evaluated_counter) return state->last_output;
    elapsed = (double)(now - state->evaluated_counter) / (double)frequency;
    if (state->move_seen) {
        moving_area = crouch_move_area(
            (double)(now - state->last_move_counter) / (double)frequency) -
            crouch_move_area((double)(state->evaluated_counter -
                state->last_move_counter) / (double)frequency);
    }
    distance = fabs((double)state->target - state->start_output);
    idle = crouch_idle_seconds(state->target);
    state->phase += (elapsed / idle +
        moving_area * (1.0 / CROUCH_MOVE_SECONDS - 1.0 / idle)) / distance;
    state->evaluated_counter = now;
    if (state->phase >= 1.0) {
        state->phase = 1.0;
        state->transitioning = 0;
        state->transition_end_counter = 0;
        *completed = 1;
        return state->target;
    }
    return (float)((double)state->start_output +
        ((double)state->target - state->start_output) *
        (1.0 - cos(3.14159265358979323846 * state->phase)) * 0.5);
}

static void crouch_transition_start(
    crouch_transition_state *state, float output, float desired,
    int64_t now, int64_t frequency) {
    double age = state->move_seen
        ? (double)(now - state->last_move_counter) / (double)frequency
        : 2.0 * CROUCH_MOVE_RECENT_SECONDS;
    double moving = 2.0 - age / CROUCH_MOVE_RECENT_SECONDS;
    double idle = crouch_idle_seconds(desired);
    double distance = fabs((double)desired - output);
    if (moving < 0.0) moving = 0.0;
    if (moving > 1.0) moving = 1.0;
    state->start_output = output;
    state->target = desired;
    /* Remaining distance scales time, so short taps do not take a fresh full
     * 400/200/250 ms. The sine curve and uninterrupted endpoints are retained.
     * Reversal is position-continuous; its velocity deliberately restarts at 0. */
    state->duration_seconds = distance /
        (1.0 / idle + moving * (1.0 / CROUCH_MOVE_SECONDS - 1.0 / idle));
    state->start_counter = now;
    state->evaluated_counter = now;
    state->phase = 0.0;
    state->transitioning = distance > 0.0;
    /* Conservative deadline for eviction: locomotion can change mid-blend. */
    state->transition_end_counter = state->transitioning
        ? now + (int64_t)(ceil(distance *
            (idle > CROUCH_MOVE_SECONDS ? idle : CROUCH_MOVE_SECONDS) *
            (double)frequency)) : 0;
}

#endif
