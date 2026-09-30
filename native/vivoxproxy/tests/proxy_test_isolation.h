#ifndef ROTK_PROXY_TEST_ISOLATION_H
#define ROTK_PROXY_TEST_ISOLATION_H

#include <windows.h>
#include <stdio.h>

/* These are ABI/load tests of a supplied proxy, not an installation of its
 * external runtime module. Refuse to run unless Windows prevents the proxy
 * from starting its download helper. This affects only the test process. */
static int isolate_proxy_test(void) {
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy = {0};
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY actual = {0};
    policy.NoChildProcessCreation = 1;
    if (!SetProcessMitigationPolicy(ProcessChildProcessPolicy, &policy, sizeof(policy)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy,
                                    &actual, sizeof(actual)) ||
        !actual.NoChildProcessCreation) {
        fprintf(stderr, "FAIL: cannot restrict test child processes (error=%lu)\n", GetLastError());
        return 0;
    }
    return 1;
}

#endif
