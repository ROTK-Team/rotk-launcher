#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static int pressed_mouse, mouse_queries;
static BOOL foreign_foreground;
static SHORT WINAPI mouse_state(int key) {
    ++mouse_queries;
    return key == pressed_mouse ? (SHORT)0x8000 : 0;
}
#define GetAsyncKeyState mouse_state
static DWORD WINAPI own_window(HWND window, LPDWORD process) {
    (void)window; *process = foreign_foreground ? 0 : GetCurrentProcessId(); return GetCurrentThreadId();
}
#define GetWindowThreadProcessId own_window
#define DirectInput8Create RotkTestDirectInput8Create
#define DllCanUnloadNow RotkTestDllCanUnloadNow
#define DllGetClassObject RotkTestDllGetClassObject
#define DllRegisterServer RotkTestDllRegisterServer
#define DllUnregisterServer RotkTestDllUnregisterServer
#define GetdfDIJoystick RotkTestGetdfDIJoystick
#define DllMain RotkTestDllMain
#include "../dinput8_proxy.c"
#undef NDEBUG
#include <assert.h>
static unsigned original_idle_calls;
static void original_idle(BYTE *actor) { (void)actor; ++original_idle_calls; }
int main(void) {
    BYTE *image = VirtualAlloc(NULL, 0x4780000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    BYTE actor[0x1100] = {0}, vt[0x500] = {0}; DWORD old;
    const BYTE setter[] = {0x89,0x91,0xa0,0x09,0,0,0xc3};
    assert(image); stance_base=image;
    memcpy(image+0x7a2de,setter,sizeof(setter));
    assert(VirtualProtect(image+0x7a2de,sizeof(setter),PAGE_EXECUTE_READ,&old));
    assert(FlushInstructionCache(GetCurrentProcess(),image+0x7a2de,sizeof(setter)));
    *(uintptr_t *)actor=(uintptr_t)vt; *(uintptr_t *)(vt+0x4d8)=(uintptr_t)(image+0x7a2de);
    stance_set(actor,1); assert(stance_u32(actor+0x9a0)==1);
    stance_set(actor,0); assert(stance_u32(actor+0x9a0)==0);
    *(uintptr_t *)(vt+0x4d8)=(uintptr_t)(image+0x7a2dd);
    stance_set(actor,1); assert(stance_u32(actor+0x9a0)==0);
    BYTE manager[0x22d8]={0}, context[0xc0]={0}, action[0x190]={0}; uintptr_t table[16]={0};
    *(uintptr_t *)(manager+0x2d8+(stance_hash("Generic")&1023)*8)=(uintptr_t)context;
    *(uintptr_t *)(context+8)=(uintptr_t)"Generic"; *(uint32_t *)(context+0x10)=7;
    *(uintptr_t *)(context+0x80)=(uintptr_t)table; *(uintptr_t *)(context+0x88)=16;
    *(uintptr_t *)(action+8)=(uintptr_t)"ToggleWeaponStance";
    /* Derive the native string length, including all eighteen bytes. */
    *(uint32_t *)(action+0x10)=(uint32_t)strlen("ToggleWeaponStance");
    table[stance_hash("ToggleWeaponStance")&15]=(uintptr_t)action;
    assert(stance_action(manager,"ToggleWeaponStance")==action+0x18);
    assert(!stance_action_pressed(action+0x18)); action[0x130]=1;
    assert(stance_action_pressed(action+0x18)); assert(!stance_action(manager,"ROTKConsole"));
    *(uintptr_t *)(context+0x88)=15; assert(!stance_action(manager,"ToggleWeaponStance"));
    BYTE infantry[0xc0]={0}, fire[0x190]={0}, aim[0x190]={0}; uintptr_t inputs[16]={0};
    *(uintptr_t *)(manager+0x2d8+(stance_hash("Infantry")&1023)*8)=(uintptr_t)infantry;
    *(uintptr_t *)(infantry+8)=(uintptr_t)"Infantry"; *(uint32_t *)(infantry+0x10)=8;
    *(uintptr_t *)(infantry+0x80)=(uintptr_t)inputs; *(uintptr_t *)(infantry+0x88)=16;
    BYTE *nodes[]={fire,aim}; const char *names[]={"Fire","SecondaryFire"};
    for (unsigned i=0;i<2;++i) {
        BYTE *entry=nodes[i]; unsigned bucket=stance_hash(names[i])&15;
        *(uintptr_t *)(entry+8)=(uintptr_t)names[i]; *(uint32_t *)(entry+0x10)=(uint32_t)strlen(names[i]);
        *(uintptr_t *)(entry+0x188)=inputs[bucket]; inputs[bucket]=(uintptr_t)entry;
    }
    assert(!stance_action(NULL,"ToggleWeaponStance"));
    /* Logical actions alone must not raise the weapon after the rollback. */
    static BYTE game[0x384e0], ui[0x350];
    const BYTE no_focus[]={0x31,0xc0,0xc3};
    memcpy(image+0x1c138e0,no_focus,sizeof(no_focus));
    assert(VirtualProtect(image+0x1c138e0,sizeof(no_focus),PAGE_EXECUTE_READ,&old));
    assert(FlushInstructionCache(GetCurrentProcess(),image+0x1c138e0,sizeof(no_focus)));
    *(uintptr_t *)(image+0x476dc08)=(uintptr_t)game;
    *(uintptr_t *)(game+0x384d8)=(uintptr_t)ui;
    *(uintptr_t *)(game+0x382c8)=(uintptr_t)manager;
    *(uintptr_t *)actor=(uintptr_t)(image+0x387fdb0);
    *(uintptr_t *)(image+0x387fdb0+0x4d8)=(uintptr_t)(image+0x7a2de);
    *(uintptr_t *)(context+0x88)=16; action[0x130]=0;
    stance_enabled=TRUE; stance_last_actor=actor;
    for (unsigned i=0;i<2;++i) {
        stance_initialized=TRUE; *(int *)(actor+0x9a0)=0;
        nodes[i][0x130]=1; stance_idle(actor);
        assert(stance_u32(actor+0x9a0)==0);
        nodes[i][0x130]=0;
    }
    const int buttons[]={VK_LBUTTON,VK_RBUTTON};
    for (unsigned i=0;i<2;++i) {
        for (int lowered=-1;lowered<=0;++lowered) {
            *(int *)(actor+0x9a0)=lowered; pressed_mouse=buttons[i]; stance_idle(actor);
            assert(stance_u32(actor+0x9a0)==1);
            stance_idle(actor); assert(stance_u32(actor+0x9a0)==1);
        }
    }
    pressed_mouse=0;
    *(int *)(actor+0x9a0)=0; stance_idle(actor);
    assert(stance_u32(actor+0x9a0)==0);
    action[0x130]=1; stance_idle(actor); assert(stance_u32(actor+0x9a0)==1);
    stance_idle(actor); assert(stance_u32(actor+0x9a0)==1);
    action[0x130]=0; stance_idle(actor);
    action[0x130]=1; stance_idle(actor); assert(stance_u32(actor+0x9a0)==0);
    action[0x130]=0; stance_idle(actor);
    pressed_mouse=VK_LBUTTON; action[0x130]=1;
    stance_idle(actor); assert(stance_u32(actor+0x9a0)==1);
    stance_idle(actor); assert(stance_u32(actor+0x9a0)==1);
    foreign_foreground=TRUE; mouse_queries=0; *(int *)(actor+0x9a0)=0;
    stance_idle(actor); assert(stance_u32(actor+0x9a0)==0 && mouse_queries==0);
    assert(!stance_pressed);
    foreign_foreground=FALSE; pressed_mouse=0; action[0x130]=0;
    stance_original_idle=original_idle; stance_enabled=FALSE;
    stance_idle(actor); assert(original_idle_calls==1 && mouse_queries==0);
    stance_enabled=TRUE; *(uintptr_t *)actor=(uintptr_t)vt;
    stance_idle(actor); assert(original_idle_calls==2 && mouse_queries==0);
    puts("PASS mouse raise, held input, stance binding, focus and native fallback; Infantry actions ignored");
    VirtualFree(image,0,MEM_RELEASE);
    puts("PASS: native virtual setter thunk, foreign target refusal, input registry, pressed bit and corrupt table refusal.");
    return 0;
}
