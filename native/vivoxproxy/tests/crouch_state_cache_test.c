#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../crouch_state_cache.h"

/* Keep every check active under the same optimized build used by releases. */
#undef assert
#define assert(condition)                                                     \
    do {                                                                      \
        if (!(condition)) {                                                   \
            fprintf(                                                         \
                stderr,                                                       \
                "check failed at %s:%d: %s\n",                              \
                __FILE__,                                                     \
                __LINE__,                                                     \
                #condition);                                                  \
            ExitProcess(1U);                                                  \
        }                                                                     \
    } while (0)

#define SOLO_PLAYERS 50U
#define TEST_STALE_TICKS 2000
#define TEST_THREAD_ITERATIONS 10000U

typedef struct cache_thread_context {
    unsigned int index;
    int shared_key;
} cache_thread_context;

static SRWLOCK g_test_cache_lock = SRWLOCK_INIT;
static crouch_transition_state g_thread_states[CROUCH_STATE_CAPACITY];
static volatile LONG g_thread_failures;
static volatile LONG64 g_test_call_sequence;
static size_t g_test_hints[512U];
static HANDLE g_thread_start_event;

static void *fake_network(uintptr_t value) {
    return (void *)(uintptr_t)(value << 4U);
}

static crouch_transition_state *acquire_with_sequence(
    crouch_transition_state *states,
    uintptr_t network_id,
    uintptr_t generation,
    uintptr_t control_generation,
    int64_t now,
    int64_t call_sequence,
    crouch_state_cache_lookup *lookup) {
    return crouch_state_cache_acquire_hint(
        states,
        CROUCH_STATE_CAPACITY,
        g_test_hints,
        sizeof(g_test_hints) / sizeof(g_test_hints[0]),
        fake_network(network_id),
        generation,
        control_generation,
        now,
        TEST_STALE_TICKS,
        call_sequence,
        lookup);
}

static crouch_transition_state *acquire_with_identity(
    crouch_transition_state *states,
    uintptr_t network_id,
    uintptr_t generation,
    uintptr_t control_generation,
    int64_t now,
    crouch_state_cache_lookup *lookup) {
    return acquire_with_sequence(
        states,
        network_id,
        generation,
        control_generation,
        now,
        (int64_t)InterlockedIncrement64(&g_test_call_sequence),
        lookup);
}

static crouch_transition_state *acquire(
    crouch_transition_state *states,
    uintptr_t network_id,
    uintptr_t generation,
    int64_t now,
    crouch_state_cache_lookup *lookup) {
    return acquire_with_identity(
        states,
        network_id,
        generation,
        generation + 1000000U,
        now,
        lookup);
}

static size_t occupied_count(const crouch_transition_state *states) {
    size_t count = 0U;
    size_t index;

    for (index = 0U; index < CROUCH_STATE_CAPACITY; ++index) {
        if (states[index].network != NULL) {
            ++count;
        }
    }
    return count;
}

static void test_full_solo_handoff_has_headroom(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;
    crouch_transition_state *local;
    size_t index;

    memset(states, 0, sizeof(states));
    assert(CROUCH_STATE_CAPACITY >= SOLO_PLAYERS * 4U);

    local = acquire(states, 1U, 1001U, 1, &lookup);
    assert(local != NULL);
    local->initialized = 1;
    local->transitioning = 1;
    local->transition_end_counter = 401;
    local->target = 1.0f;

    for (index = 1U; index < SOLO_PLAYERS; ++index) {
        assert(acquire(states, 1U + index, 1001U + index, 2, &lookup) != NULL);
        assert(lookup.event == CROUCH_STATE_CACHE_INSERTED);
    }
    for (index = 0U; index < SOLO_PLAYERS; ++index) {
        assert(acquire(states, 101U + index, 2001U + index, 3, &lookup) != NULL);
        assert(lookup.event == CROUCH_STATE_CACHE_INSERTED);
    }
    for (index = 0U; index < SOLO_PLAYERS * 2U; ++index) {
        assert(acquire(states, 201U + index, 3001U + index, 4, &lookup) != NULL);
        assert(lookup.event == CROUCH_STATE_CACHE_INSERTED);
    }

    assert(occupied_count(states) == SOLO_PLAYERS * 4U);
    assert(acquire(states, 1U, 1001U, 5, &lookup) == local);
    assert(lookup.event == CROUCH_STATE_CACHE_HIT);
    assert(local->initialized == 1);
    assert(local->transitioning == 1);
    assert(local->target == 1.0f);
}

static void test_old_hash_collisions_preserve_parallel_transitions(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_transition_state *expected[128];
    crouch_state_cache_lookup lookup;
    size_t index;

    memset(states, 0, sizeof(states));
    for (index = 0U; index < 128U; ++index) {
        uintptr_t network_id = 1U + index * 16U;
        expected[index] = acquire(
            states,
            network_id,
            5000U + index,
            0,
            &lookup);
        assert(expected[index] != NULL);
        expected[index]->initialized = 1;
        expected[index]->transitioning = 1;
        expected[index]->start_counter = 0;
        expected[index]->transition_end_counter = 400;
        expected[index]->start_output = 0.0f;
        expected[index]->target = 1.0f;
    }

    for (index = 0U; index < 128U; ++index) {
        uintptr_t network_id = 1U + index * 16U;
        crouch_transition_state *state = acquire(
            states,
            network_id,
            5000U + index,
            200,
            &lookup);
        assert(state == expected[index]);
        assert(lookup.event == CROUCH_STATE_CACHE_HIT);
        assert(state->transitioning == 1);
        assert(state->start_counter == 0);
        assert(state->transition_end_counter == 400);
        assert(state->start_output == 0.0f);
        assert(state->target == 1.0f);
    }
}

static void fill_cache(
    crouch_transition_state *states,
    int64_t now,
    int transitioning,
    int64_t transition_end) {
    crouch_state_cache_lookup lookup;
    size_t index;

    memset(states, 0, sizeof(crouch_transition_state) * CROUCH_STATE_CAPACITY);
    for (index = 0U; index < CROUCH_STATE_CAPACITY; ++index) {
        crouch_transition_state *state = acquire(
            states,
            10000U + index,
            20000U + index,
            now,
            &lookup);
        assert(state != NULL);
        state->initialized = 1;
        state->transitioning = transitioning;
        state->transition_end_counter = transition_end;
    }
}

static void test_ttl_boundary(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_transition_state snapshot[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;

    fill_cache(states, 0, 0, 0);
    memcpy(snapshot, states, sizeof(states));

    assert(acquire(states, 40000U, 41000U, TEST_STALE_TICKS, &lookup) == NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_PRESSURE);
    assert(memcmp(snapshot, states, sizeof(states)) == 0);

    assert(acquire(states, 40000U, 41000U, TEST_STALE_TICKS + 1, &lookup) != NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_EVICTED);
    assert(lookup.previous_network == fake_network(10000U));
}

static void test_lru_uses_last_seen_order(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;
    int64_t insertion_time =
        TEST_STALE_TICKS + (int64_t)CROUCH_STATE_CAPACITY + 10;
    size_t index;

    memset(states, 0, sizeof(states));
    for (index = 0U; index < CROUCH_STATE_CAPACITY; ++index) {
        assert(acquire(
            states,
            10000U + index,
            20000U + index,
            (int64_t)index,
            &lookup) != NULL);
    }
    assert(acquire(states, 10000U, 20000U, 1000, &lookup) != NULL);
    assert(acquire(states, 45000U, 46000U, insertion_time, &lookup) != NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_EVICTED);
    assert(lookup.previous_network == fake_network(10001U));
}

static void test_oldest_active_transition_is_skipped(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;

    fill_cache(states, 0, 0, 0);
    states[0].transitioning = 1;
    states[0].transition_end_counter = TEST_STALE_TICKS + 10000;

    assert(acquire(states, 47000U, 48000U, TEST_STALE_TICKS + 1, &lookup) != NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_EVICTED);
    assert(lookup.previous_network == fake_network(10001U));
    assert(states[0].network == fake_network(10000U));
    assert(states[0].transitioning == 1);
}

static void test_active_transition_is_never_evicted(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_transition_state snapshot[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;

    fill_cache(states, 0, 1, TEST_STALE_TICKS + 10000);
    memcpy(snapshot, states, sizeof(states));

    assert(acquire(states, 50000U, 51000U, TEST_STALE_TICKS + 1, &lookup) == NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_PRESSURE);
    assert(memcmp(snapshot, states, sizeof(states)) == 0);
}

static void test_expired_transition_flag_is_reclaimable(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;

    fill_cache(states, 0, 1, 400);
    assert(acquire(states, 60000U, 61000U, TEST_STALE_TICKS + 1, &lookup) != NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_EVICTED);
    assert(lookup.previous_network == fake_network(10000U));
}

static void test_generation_and_stale_resets_clear_transition(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;
    crouch_transition_state *state;

    memset(states, 0, sizeof(states));
    state = acquire(states, 42U, 100U, 1, &lookup);
    assert(state != NULL);
    state->initialized = 1;
    state->transitioning = 1;
    state->transition_end_counter = 500;
    state->last_output = 0.75f;

    assert(acquire(states, 42U, 101U, 2, &lookup) == state);
    assert(lookup.event == CROUCH_STATE_CACHE_GENERATION_RESET);
    assert(lookup.previous_generation == 100U);
    assert(state->generation == 101U);
    assert(state->initialized == 0);
    assert(state->transitioning == 0);
    assert(state->last_output == 0.0f);

    state->initialized = 1;
    state->target = 1.0f;
    assert(acquire_with_identity(
        states,
        42U,
        101U,
        1000200U,
        3,
        &lookup) == state);
    assert(lookup.event == CROUCH_STATE_CACHE_GENERATION_RESET);
    assert(lookup.previous_control_generation == 1000101U);
    assert(state->initialized == 0);
    assert(state->target == 0.0f);

    state->initialized = 1;
    state->last_output = 1.0f;
    assert(acquire_with_identity(
        states,
        42U,
        101U,
        1000200U,
        TEST_STALE_TICKS + 4,
        &lookup) == state);
    assert(lookup.event == CROUCH_STATE_CACHE_STALE_RESET);
    assert(state->initialized == 0);
    assert(state->last_output == 0.0f);
}

static void test_out_of_order_timestamp_cannot_age_state_backwards(void) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY];
    crouch_state_cache_lookup lookup;
    crouch_transition_state *state;
    int64_t accepted_sequence;

    memset(states, 0, sizeof(states));
    state = acquire(states, 77U, 177U, 200, &lookup);
    assert(state != NULL);
    accepted_sequence = state->last_call_sequence;
    assert(state->last_seen_counter == 200);
    state->initialized = 1;
    state->transitioning = 1;
    state->transition_end_counter = 400;
    assert(acquire_with_sequence(
        states,
        77U,
        177U,
        1000177U,
        100,
        accepted_sequence - 1,
        &lookup) == NULL);
    assert(lookup.event == CROUCH_STATE_CACHE_OUT_OF_ORDER);
    assert(state->last_seen_counter == 200);
    assert(state->last_call_sequence == accepted_sequence);
    assert(state->initialized == 1);
    assert(state->transitioning == 1);
    assert(state->transition_end_counter == 400);
}

static DWORD WINAPI cache_thread(LPVOID parameter) {
    const cache_thread_context *context =
        (const cache_thread_context *)parameter;
    unsigned int iteration;

    if (WaitForSingleObject(g_thread_start_event, INFINITE) != WAIT_OBJECT_0) {
        InterlockedIncrement(&g_thread_failures);
        return 1U;
    }

    for (iteration = 0U; iteration < TEST_THREAD_ITERATIONS; ++iteration) {
        uintptr_t network_id = context->shared_key
            ? 70000U
            : 71000U + (uintptr_t)context->index * 8U + iteration % 8U;
        crouch_state_cache_lookup lookup;
        crouch_transition_state *state;

        AcquireSRWLockExclusive(&g_test_cache_lock);
        state = acquire(
            g_thread_states,
            network_id,
            80000U + network_id,
            100,
            &lookup);
        if (state == NULL) {
            InterlockedIncrement(&g_thread_failures);
        } else {
            state->initialized = 1;
        }
        ReleaseSRWLockExclusive(&g_test_cache_lock);
    }
    return 0U;
}

static void run_thread_group(unsigned int count, int shared_key) {
    HANDLE threads[16];
    cache_thread_context contexts[16];
    unsigned int index;

    assert(count <= 16U);
    g_thread_start_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    assert(g_thread_start_event != NULL);
    for (index = 0U; index < count; ++index) {
        contexts[index].index = index;
        contexts[index].shared_key = shared_key;
        threads[index] = CreateThread(
            NULL,
            0U,
            cache_thread,
            &contexts[index],
            0U,
            NULL);
        assert(threads[index] != NULL);
    }
    assert(SetEvent(g_thread_start_event));
    assert(WaitForMultipleObjects(count, threads, TRUE, INFINITE) == WAIT_OBJECT_0);
    for (index = 0U; index < count; ++index) {
        assert(CloseHandle(threads[index]));
    }
    assert(CloseHandle(g_thread_start_event));
    g_thread_start_event = NULL;
}

static void test_serialized_thread_stress(void) {
    memset(g_thread_states, 0, sizeof(g_thread_states));
    g_thread_failures = 0L;
    run_thread_group(8U, 0);
    assert(g_thread_failures == 0L);
    assert(occupied_count(g_thread_states) == 64U);

    memset(g_thread_states, 0, sizeof(g_thread_states));
    g_thread_failures = 0L;
    run_thread_group(16U, 1);
    assert(g_thread_failures == 0L);
    assert(occupied_count(g_thread_states) == 1U);
}

static void test_hints_and_measure(void) {
    static crouch_transition_state reference[CROUCH_STATE_CAPACITY], hinted[CROUCH_STATE_CAPACITY];
    size_t hints[CROUCH_STATE_CAPACITY] = {0};
    uint32_t random = 17;
    for (int64_t n = 1; n <= 10000; ++n) {
        random = random * 1664525U + 1013904223U;
        /* Includes deliberate hint collisions, pressure, expiry and generations. */
        void *network = fake_network((random % 300U + 1U) * 256U);
        uintptr_t generation = 1U + (random >> 24U) % 2U;
        crouch_state_cache_lookup a, b;
        int64_t sequence = n % 13 == 0 ? 1 : n;
        crouch_transition_state *left = crouch_state_cache_acquire(reference, CROUCH_STATE_CAPACITY,
            network, generation, 1, n, 2000, sequence, &a);
        crouch_transition_state *right = crouch_state_cache_acquire_hint(hinted, CROUCH_STATE_CAPACITY,
            hints, CROUCH_STATE_CAPACITY, network, generation, 1, n, 2000, sequence, &b);
        assert((left == NULL) == (right == NULL));
        assert(!left || left-reference == right-hinted);
        assert(a.event == b.event && a.previous_network == b.previous_network);
        assert(a.previous_generation == b.previous_generation && a.previous_control_generation == b.previous_control_generation);
        assert(memcmp(reference, hinted, sizeof(reference)) == 0);
    }
    LARGE_INTEGER frequency, begin, end;
    QueryPerformanceFrequency(&frequency);
    for (int run=0; run<3; ++run) {
        double times[2];
        for (int fast=0; fast<2; ++fast) {
            memset(reference, 0, sizeof(reference)); memset(hints, 0, sizeof(hints));
            QueryPerformanceCounter(&begin);
            for (int64_t n=1; n<=500000; ++n) {
                void *network=fake_network((uintptr_t)(n%200+1));
                crouch_transition_state *entry = fast
                    ? crouch_state_cache_acquire_hint(reference, CROUCH_STATE_CAPACITY, hints, CROUCH_STATE_CAPACITY, network,1,1,n,2000,n,NULL)
                    : crouch_state_cache_acquire(reference,CROUCH_STATE_CAPACITY,network,1,1,n,2000,n,NULL);
                assert(entry != NULL);
            }
            QueryPerformanceCounter(&end);
            times[fast] = (double)(end.QuadPart-begin.QuadPart)*1000/frequency.QuadPart;
        }
        printf("CACHE benchmark 200 networks / 500000 calls: scan %.3f ms, hints %.3f ms\n",times[0],times[1]);
    }
}

int main(void) {
    test_hints_and_measure();
    test_full_solo_handoff_has_headroom();
    test_old_hash_collisions_preserve_parallel_transitions();
    test_ttl_boundary();
    test_lru_uses_last_seen_order();
    test_oldest_active_transition_is_skipped();
    test_active_transition_is_never_evicted();
    test_expired_transition_flag_is_reclaimable();
    test_generation_and_stale_resets_clear_transition();
    test_out_of_order_timestamp_cannot_age_state_backwards();
    test_serialized_thread_stress();
    puts("crouch state cache tests passed");
    return 0;
}
