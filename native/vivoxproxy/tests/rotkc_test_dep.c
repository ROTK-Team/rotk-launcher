/*
 * Import of the rotkc.dll test double's "with dependency" variant. The test
 * places it only on PATH, the way some machines only have the VC++ runtime
 * on PATH, to exercise the proxy's legacy import-search retry.
 */
#include <windows.h>

__declspec(dllexport) int rotkc_test_dependency(void) {
    return 1;
}
