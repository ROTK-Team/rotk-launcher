# Native menu Duo presentation

The main-menu static view selects characters from the native Steam lobby member
list. The launcher initializes the shim's observer-local lobby through the
existing compact `thirdPartyCommandLine=+connect_lobby109775241000000001` argument.
Without a matching server/UI frame, the shim continues to expose only the owner.

The server publishes the admitted presentation actor through an owner-only
`ROTK_MENU_DUO_V1` broadcast. The matching UIRoot forwards its bounded text using
SteamSendChatToLobby; the engine prefixes it with `@CHAT:`. `menu_duo_native.h`
validates the monotone sequence, exact u64 identities, display-actor namespace,
URI-encoded name and clear grammar before staging an update. Native callbacks
run on SteamAPI_RunCallbacks, outside the UI call. Expiry after 20 seconds or an
explicit clear removes the member. This does not change authoritative Social
party membership or gameplay admission. No runtime file adapter is used.

Teammates after the first use `ROTK_MENU_TRIO_V1|seq|slot|member|actor|name`,
where `slot` is exactly one character `2`, `3` or `4` (Trios uses `2`; Fives
uses `2`-`4`). Each of the four slots has its own sequence and 20-second lease,
and a member or actor id already held (displayed or pending) by any other slot
is rejected. The lobby shows only the consecutive filled slots from slot one,
so scene slots never renumber: while an earlier slot is empty, later members
are hidden (leave callback) but their proposal is kept until its own lease
ends, and they return without a new frame once the gap is filled.
`ROTK_MENU_DUO_CLEAR_V1` empties all four slots.

Run `npm run test:native:menu-duo` with Zig 0.15.2 available. The test compiles the
actual shim code and exercises matchmaking calls, deferred callbacks, exact IDs,
UTF-8 names, replacement, leave/rejoin, expiry and malformed/stale input
(`menu_duo_test.c`), the second teammate (`menu_trio_test.c`) and four teammates
(`menu_fives_test.c`). Checks explicitly remain enabled when Zig -O2 defines
NDEBUG.

The generated `native/steamshim/dist/menu-duo-test.exe --wire` additionally reads
four server-generated frames from stdin (join, replacement, clear, rejoin). The
matching server repository provides `prove-menu-duo-native-wire1315.ts` for this
cross-language contract check.

The corrected network integration was visually accepted in two isolated game
clients on 2026-09-18; read-only native diagnostics confirmed two members each.
Rebuilt UIRoot assets and server opt-in `H1Z1_MENU_DUO_SCENE=1` must ship together
with this shim. This change does not itself publish a launcher or enable servers.
