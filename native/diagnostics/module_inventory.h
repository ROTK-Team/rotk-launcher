/* Report-only inventory of the executable images mapped in the watched game.
 * It uses the query rights the helper already holds: region and mapped-file
 * names only, no read of process memory. It loads nothing into the game, never
 * suspends, signals or blocks it, and never uses the network: signature checks
 * accept cached certificate data only and skip revocation. Each image is written
 * as a file name and a location class; full paths are never written. Nothing
 * here decides anything about the player or the game. Any failure is
 * reported and the helper keeps watching. File work (signatures, hashes) is
 * queued and done in small slices so the watch loop keeps seeing the exit and
 * its commands. */
#ifndef ROTK_DIAGNOSTICS_MODULE_INVENTORY_H
#define ROTK_DIAGNOSTICS_MODULE_INVENTORY_H

#include <tlhelp32.h>
#include <wintrust.h>
#include <softpub.h>
#include <bcrypt.h>

#ifndef INVENTORY_FIRST_SCAN_MS
#define INVENTORY_FIRST_SCAN_MS 15000ULL
#endif
#ifndef INVENTORY_INTERVAL_MS
#define INVENTORY_INTERVAL_MS 30000ULL
#endif
#define INVENTORY_CAPACITY 1024
#define INVENTORY_EVENT_LIMIT 768
#define INVENTORY_HASH_LIMIT (64ULL * 1024 * 1024)
#define INVENTORY_NAME_CAP 96
#define INVENTORY_ROOT_CAP 10
#define INVENTORY_PENDING_CAP 256
#define INVENTORY_CHECK_BUDGET_MS 50.0

enum { INVENTORY_SYSTEM, INVENTORY_WINDOWS, INVENTORY_GAME, INVENTORY_OTHER, INVENTORY_KINDS };
static const char *const inventory_kind_names[INVENTORY_KINDS] = {"system", "windows", "game", "other"};

typedef struct {
    uintptr_t base;
    uint32_t path_hash;
    unsigned char kind, seen, trusted;
    wchar_t name[INVENTORY_NAME_CAP];
} INVENTORY_IMAGE;

static struct {
    BOOL enabled;
    wchar_t image_path[PATH_CAP];
    const wchar_t *image_name;
    size_t game_length;
    wchar_t windows_dir[MAX_PATH];
    size_t windows_length;
    struct { wchar_t path[MAX_PATH]; size_t length; const char *location; } roots[INVENTORY_ROOT_CAP];
    unsigned root_count;
    struct { wchar_t device[MAX_PATH]; size_t length; wchar_t letter; } drives[26];
    unsigned drive_count;
    INVENTORY_IMAGE images[INVENTORY_CAPACITY];
    unsigned count, untracked;
    ULONGLONG next_scan;
    unsigned scans, failed_scans, events;
    uint64_t added_total, removed_total;
    int debugger_last;
    BOOL debugger_seen, same_name_known, event_limit_reached;
    unsigned same_name_last, same_name_max;
    double max_scan_ms;
} inventory;

static uint32_t inventory_hash(const wchar_t *text) {
    uint32_t hash = 2166136261u;
    for (; *text; ++text) {
        wchar_t c = *text;
        if (c >= L'A' && c <= L'Z') c = (wchar_t)(c + (L'a' - L'A'));
        hash ^= (uint32_t)c;
        hash *= 16777619u;
    }
    return hash;
}

static BOOL inventory_under(const wchar_t *path, const wchar_t *root, size_t length) {
    return length > 0 && _wcsnicmp(path, root, length) == 0 && path[length] == L'\\';
}

static size_t inventory_trim(wchar_t *path) {
    size_t length = wcslen(path);
    while (length > 3 && path[length - 1] == L'\\') path[--length] = 0;
    return length;
}

static void inventory_add_root(const wchar_t *variable, const char *location) {
    if (inventory.root_count >= INVENTORY_ROOT_CAP) return;
    wchar_t raw[MAX_PATH];
    DWORD length = GetEnvironmentVariableW(variable, raw, MAX_PATH);
    if (!length || length >= MAX_PATH) return;
    wchar_t *target = inventory.roots[inventory.root_count].path;
    /* TEMP is often a short 8.3 path; mapped names are always long names. */
    DWORD long_length = GetLongPathNameW(raw, target, MAX_PATH);
    if (!long_length || long_length >= MAX_PATH) wcscpy(target, raw);
    size_t trimmed = inventory_trim(target);
    /* A drive root would classify the whole drive; it is not a location. */
    if (trimmed <= 3 || target[1] != L':') return;
    inventory.roots[inventory.root_count].length = trimmed;
    inventory.roots[inventory.root_count].location = location;
    ++inventory.root_count;
}

static void inventory_refresh_drives(void) {
    DWORD mask = GetLogicalDrives();
    inventory.drive_count = 0;
    for (unsigned letter = 0; letter < 26; ++letter) {
        if (!(mask & (1UL << letter))) continue;
        wchar_t name[3] = {(wchar_t)(L'A' + letter), L':', 0};
        wchar_t *device = inventory.drives[inventory.drive_count].device;
        if (!QueryDosDeviceW(name, device, MAX_PATH)) continue;
        inventory.drives[inventory.drive_count].length = wcslen(device);
        inventory.drives[inventory.drive_count].letter = name[0];
        ++inventory.drive_count;
    }
}

static BOOL inventory_dos_path(const wchar_t *device_path, wchar_t *output, size_t capacity) {
    for (unsigned i = 0; i < inventory.drive_count; ++i) {
        size_t length = inventory.drives[i].length;
        if (!length || _wcsnicmp(device_path, inventory.drives[i].device, length) != 0 || device_path[length] != L'\\') continue;
        size_t rest = wcslen(device_path + length);
        if (rest + 3 > capacity) return FALSE;
        output[0] = inventory.drives[i].letter;
        output[1] = L':';
        memcpy(output + 2, device_path + length, (rest + 1) * sizeof(wchar_t));
        return TRUE;
    }
    return FALSE;
}

typedef struct { unsigned kind; const char *location; unsigned depth; BOOL local, main; } INVENTORY_CLASS;

static INVENTORY_CLASS inventory_classify(const wchar_t *path, BOOL converted) {
    INVENTORY_CLASS result = {INVENTORY_OTHER, NULL, 0, FALSE, FALSE};
    if (!converted) {
        result.location = _wcsnicmp(path, L"\\Device\\Mup\\", 12) == 0 ? "network" : "unmapped-volume";
        return result;
    }
    if (inventory_under(path, inventory.windows_dir, inventory.windows_length)) {
        const wchar_t *rest = path + inventory.windows_length + 1;
        result.kind = _wcsnicmp(rest, L"System32\\", 9) == 0 || _wcsnicmp(rest, L"WinSxS\\", 7) == 0
            ? INVENTORY_SYSTEM : INVENTORY_WINDOWS;
        result.location = "windows";
        result.local = TRUE;
        return result;
    }
    if (inventory_under(path, inventory.image_path, inventory.game_length)) {
        result.kind = INVENTORY_GAME;
        result.location = "game";
        for (const wchar_t *p = path + inventory.game_length + 1; *p; ++p) if (*p == L'\\') ++result.depth;
        result.main = _wcsicmp(path, inventory.image_path) == 0;
    } else {
        for (unsigned i = 0; i < inventory.root_count && !result.location; ++i)
            if (inventory_under(path, inventory.roots[i].path, inventory.roots[i].length)) result.location = inventory.roots[i].location;
    }
    wchar_t drive[] = {path[0], L':', L'\\', 0};
    UINT type = GetDriveTypeW(drive);
    result.local = type == DRIVE_FIXED;
    if (!result.location) {
        result.location = type == DRIVE_FIXED ? "other-local" : type == DRIVE_REMOVABLE ? "removable"
            : type == DRIVE_REMOTE ? "network" : "other";
    }
    return result;
}

typedef struct { const char *status; LONG code; wchar_t signer[128]; } INVENTORY_SIGNATURE;

/* Embedded Authenticode only: a file signed through a catalog reads as "none". */
static void inventory_signature(const wchar_t *path, INVENTORY_SIGNATURE *result) {
    WINTRUST_FILE_INFO file;
    WINTRUST_DATA data;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    memset(&file, 0, sizeof(file));
    memset(&data, 0, sizeof(data));
    memset(result, 0, sizeof(*result));
    file.cbStruct = sizeof(file);
    file.pcwszFilePath = path;
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &file;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;
    LONG status = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &data);
    result->code = status;
    switch ((unsigned long)status) {
    case ERROR_SUCCESS: result->status = "valid"; break;
    case (unsigned long)TRUST_E_NOSIGNATURE: case (unsigned long)TRUST_E_SUBJECT_FORM_UNKNOWN:
    case (unsigned long)TRUST_E_PROVIDER_UNKNOWN: result->status = "none"; break;
    case (unsigned long)CERT_E_CHAINING: case (unsigned long)CERT_E_UNTRUSTEDROOT:
    case (unsigned long)CERT_E_UNTRUSTEDTESTROOT: result->status = "chain-unverified"; break;
    case (unsigned long)CERT_E_EXPIRED: result->status = "expired"; break;
    case (unsigned long)TRUST_E_BAD_DIGEST: case (unsigned long)TRUST_E_EXPLICIT_DISTRUST:
    case (unsigned long)CERT_E_REVOKED: case (unsigned long)TRUST_E_CERT_SIGNATURE: result->status = "invalid"; break;
    default: result->status = "error"; break;
    }
    if (data.hWVTStateData) {
        CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(data.hWVTStateData);
        CRYPT_PROVIDER_SGNR *signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : NULL;
        CRYPT_PROVIDER_CERT *certificate = signer ? WTHelperGetProvCertFromChain(signer, 0) : NULL;
        if (certificate && certificate->pCert)
            CertGetNameStringW(certificate->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, NULL, result->signer, 128);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &data);
    }
}

static const char *inventory_sha256(const wchar_t *path, char hex[65], uint64_t *bytes) {
    static unsigned char buffer[256 * 1024];
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (file == INVALID_HANDLE_VALUE) return "unavailable";
    LARGE_INTEGER size = {0};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0) { CloseHandle(file); return "unavailable"; }
    if ((uint64_t)size.QuadPart > INVENTORY_HASH_LIMIT) { CloseHandle(file); *bytes = (uint64_t)size.QuadPart; return "too-large"; }
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    unsigned char digest[32];
    const char *status = "unavailable";
    uint64_t total = 0;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) == 0 &&
        BCryptCreateHash(algorithm, &hash, NULL, 0, NULL, 0, 0) == 0) {
        DWORD read = 0;
        BOOL ok = TRUE;
        while ((ok = ReadFile(file, buffer, sizeof(buffer), &read, NULL)) && read) {
            if (BCryptHashData(hash, buffer, read, 0) != 0) { ok = FALSE; break; }
            total += read;
            if (total > INVENTORY_HASH_LIMIT) { ok = FALSE; break; }
        }
        if (ok && BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
            for (unsigned i = 0; i < sizeof(digest); ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
            *bytes = total;
            status = NULL;
        }
    }
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(file);
    return status;
}

/* Names only: other processes are never opened. */
static BOOL inventory_same_name(unsigned *count) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    PROCESSENTRY32W entry;
    memset(&entry, 0, sizeof(entry));
    entry.dwSize = sizeof(entry);
    *count = 0;
    for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry))
        if (entry.th32ProcessID != target_pid && _wcsicmp(entry.szExeFile, inventory.image_name) == 0) ++*count;
    CloseHandle(snapshot);
    return TRUE;
}

static void inventory_store_name(wchar_t output[INVENTORY_NAME_CAP], const wchar_t *path) {
    const wchar_t *name = basename_w(path);
    size_t length = wcslen(name);
    if (length >= INVENTORY_NAME_CAP) length = INVENTORY_NAME_CAP - 1;
    memcpy(output, name, length * sizeof(wchar_t));
    output[length] = 0;
}

static void inventory_append(char *output, size_t capacity, size_t *used, const char *format, ...) {
    if (*used >= capacity) return;
    va_list args;
    va_start(args, format);
    int written = vsnprintf(output + *used, capacity - *used, format, args);
    va_end(args);
    if (written < 0) return;
    *used = (size_t)written >= capacity - *used ? capacity : *used + (size_t)written;
}

static BOOL inventory_event_allowed(void) {
    if (inventory.events < INVENTORY_EVENT_LIMIT) { ++inventory.events; return TRUE; }
    inventory.event_limit_reached = TRUE;
    return FALSE;
}

/* Signature checks and hashes read whole files, so they never run inside the
 * scan itself: new images that need them wait in this queue and the watch loop
 * works through it a little at a time, between its exit and command checks. */
typedef struct {
    uintptr_t base;
    uint32_t path_hash;
    unsigned scan;
    BOOL late, unloaded;
    INVENTORY_CLASS type;
    wchar_t *path;
} INVENTORY_PENDING;

static struct {
    INVENTORY_PENDING items[INVENTORY_PENDING_CAP];
    unsigned head, count;
} inventory_queue;

static void inventory_emit_unloaded(unsigned scan, const wchar_t *short_name, unsigned kind, uintptr_t base) {
    if (!inventory_event_allowed()) return;
    char name[INVENTORY_NAME_CAP * 4 + 16];
    json_string(short_name, name, sizeof(name));
    emit("module-image-unloaded", ",\"scan\":%u,\"name\":\"%s\",\"kind\":\"%s\",\"base\":\"0x%016llX\"",
        scan, name, inventory_kind_names[kind], (unsigned long long)base);
}

/* Writes the image's event; with check, verifies the signature first and
 * hashes third-party code without a valid one. Returns whether it is trusted. */
static BOOL inventory_emit_image(const INVENTORY_CLASS *type, uintptr_t base, const wchar_t *path, BOOL late, unsigned scan, BOOL check) {
    INVENTORY_SIGNATURE signature;
    BOOL trusted = type->kind == INVENTORY_SYSTEM || type->kind == INVENTORY_WINDOWS || type->main;
    char detail[2048] = "", hex[65] = "", name[INVENTORY_NAME_CAP * 4 + 16], signer[1024];
    size_t used = 0;
    if (type->kind == INVENTORY_GAME) inventory_append(detail, sizeof(detail), &used, ",\"depth\":%u%s", type->depth, type->main ? ",\"main\":true" : "");
    if (check) {
        inventory_signature(path, &signature);
        trusted = strcmp(signature.status, "valid") == 0;
        json_string(signature.signer, signer, sizeof(signer));
        inventory_append(detail, sizeof(detail), &used, ",\"signature\":\"%s\",\"signer\":%s%s%s",
            signature.status, signature.signer[0] ? "\"" : "null", signature.signer[0] ? signer : "", signature.signer[0] ? "\"" : "");
        if (strcmp(signature.status, "error") == 0)
            inventory_append(detail, sizeof(detail), &used, ",\"signatureError\":\"0x%08lX\"", (unsigned long)signature.code);
    } else if (type->kind == INVENTORY_GAME || type->kind == INVENTORY_OTHER) {
        inventory_append(detail, sizeof(detail), &used, ",\"signature\":\"not-checked\"");
    }
    /* Third-party code without a valid signature is identified by content, never by its path. */
    if (check && !trusted && type->kind == INVENTORY_OTHER) {
        uint64_t bytes = 0;
        const char *failure = inventory_sha256(path, hex, &bytes);
        if (failure) inventory_append(detail, sizeof(detail), &used, ",\"sha256\":null,\"hashStatus\":\"%s\"", failure);
        else inventory_append(detail, sizeof(detail), &used, ",\"sha256\":\"%s\",\"bytes\":%llu", hex, (unsigned long long)bytes);
    }
    wchar_t short_name[INVENTORY_NAME_CAP];
    inventory_store_name(short_name, path);
    json_string(short_name, name, sizeof(name));
    if (inventory_event_allowed())
        emit("module-image", ",\"scan\":%u,\"name\":\"%s\",\"kind\":\"%s\",\"location\":\"%s\",\"base\":\"0x%016llX\",\"late\":%s%s",
            scan, name, inventory_kind_names[type->kind], type->location, (unsigned long long)base, late ? "true" : "false", detail);
    return trusted;
}

static INVENTORY_IMAGE *inventory_find(uintptr_t base, uint32_t hash) {
    for (unsigned i = 0; i < inventory.count; ++i)
        if (inventory.images[i].base == base && inventory.images[i].path_hash == hash) return &inventory.images[i];
    return NULL;
}

static INVENTORY_PENDING *inventory_find_pending(uintptr_t base, uint32_t hash) {
    for (unsigned i = 0; i < inventory_queue.count; ++i) {
        INVENTORY_PENDING *item = &inventory_queue.items[(inventory_queue.head + i) % INVENTORY_PENDING_CAP];
        if (item->base == base && item->path_hash == hash) return item;
    }
    return NULL;
}

/* Works through queued checks for about budget_ms, always at least one. With
 * check FALSE (the watch is ending) it writes the rest unchecked, without file work. */
static void inventory_drain(double budget_ms, BOOL check) {
    LARGE_INTEGER frequency, begin, now;
    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&begin);
    while (inventory_queue.count) {
        INVENTORY_PENDING item = inventory_queue.items[inventory_queue.head];
        inventory_queue.head = (inventory_queue.head + 1) % INVENTORY_PENDING_CAP;
        --inventory_queue.count;
        BOOL trusted = inventory_emit_image(&item.type, item.base, item.path, item.late, item.scan, check);
        INVENTORY_IMAGE *image = inventory_find(item.base, item.path_hash);
        if (image) image->trusted = (unsigned char)trusted;
        if (item.unloaded) {
            wchar_t short_name[INVENTORY_NAME_CAP];
            inventory_store_name(short_name, item.path);
            inventory_emit_unloaded(item.scan, short_name, item.type.kind, item.base);
        }
        free(item.path);
        QueryPerformanceCounter(&now);
        if ((double)(now.QuadPart - begin.QuadPart) * 1000.0 / (double)frequency.QuadPart >= budget_ms) break;
    }
}

static INVENTORY_IMAGE *inventory_new_image(uintptr_t base, uint32_t hash, const wchar_t *path, BOOL converted, BOOL late, unsigned scan) {
    INVENTORY_CLASS type = inventory_classify(path, converted);
    BOOL check = (type.kind == INVENTORY_GAME || type.kind == INVENTORY_OTHER) && type.local && !type.main;
    BOOL trusted = type.kind == INVENTORY_SYSTEM || type.kind == INVENTORY_WINDOWS || type.main;
    wchar_t *copy = check && inventory_queue.count < INVENTORY_PENDING_CAP ? _wcsdup(path) : NULL;
    if (copy) {
        INVENTORY_PENDING *item = &inventory_queue.items[(inventory_queue.head + inventory_queue.count) % INVENTORY_PENDING_CAP];
        item->base = base;
        item->path_hash = hash;
        item->scan = scan;
        item->late = late;
        item->unloaded = FALSE;
        item->type = type;
        item->path = copy;
        ++inventory_queue.count;
    } else {
        /* A full queue writes the image unchecked rather than doing file work in the scan. */
        trusted = inventory_emit_image(&type, base, path, late, scan, FALSE);
    }
    if (inventory.count >= INVENTORY_CAPACITY) { ++inventory.untracked; return NULL; }
    INVENTORY_IMAGE *image = &inventory.images[inventory.count++];
    image->base = base;
    image->path_hash = hash;
    image->kind = (unsigned char)type.kind;
    image->trusted = (unsigned char)trusted;
    image->seen = TRUE;
    inventory_store_name(image->name, path);
    return image;
}

static void inventory_scan(void) {
    static wchar_t device_path[PATH_CAP], dos_path[PATH_CAP];
    LARGE_INTEGER frequency, begin, end;
    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&begin);
    unsigned scan = ++inventory.scans;
    BOOL first = scan == 1, complete = FALSE, exited = FALSE;
    unsigned counts[INVENTORY_KINDS] = {0}, images = 0, unnamed = 0, without_signature = 0, added = 0, removed = 0;
    DWORD error = 0;
    inventory_refresh_drives();
    for (unsigned i = 0; i < inventory.count; ++i) inventory.images[i].seen = FALSE;
    MEMORY_BASIC_INFORMATION region;
    uintptr_t address = 0;
    for (;;) {
        if (VirtualQueryEx(target_process, (LPCVOID)address, &region, sizeof(region)) != sizeof(region)) {
            error = GetLastError();
            /* The walk normally ends past the highest user address. */
            complete = error == ERROR_INVALID_PARAMETER && images > 0;
            break;
        }
        if (region.Type == MEM_IMAGE && region.BaseAddress == region.AllocationBase) {
            uintptr_t base = (uintptr_t)region.BaseAddress;
            ++images;
            DWORD length = GetMappedFileNameW(target_process, region.BaseAddress, device_path, PATH_CAP);
            if (!length || length >= PATH_CAP) { ++unnamed; }
            else {
                device_path[length] = 0;
                BOOL converted = inventory_dos_path(device_path, dos_path, PATH_CAP);
                const wchar_t *path = converted ? dos_path : device_path;
                uint32_t hash = inventory_hash(path);
                INVENTORY_IMAGE *image = inventory_find(base, hash);
                if (image) image->seen = TRUE;
                else {
                    image = inventory_new_image(base, hash, path, converted, !first, scan);
                    if (!first) ++added;
                }
                if (image) {
                    ++counts[image->kind];
                    if (!image->trusted) ++without_signature;
                }
            }
        }
        uintptr_t next = (uintptr_t)region.BaseAddress + region.RegionSize;
        if (next <= address) { complete = images > 0; break; }
        address = next;
    }
    /* A game that exited during the walk can end it early; only a live process proves unloads. */
    if (complete && WaitForSingleObject(target_process, 0) != WAIT_TIMEOUT) { complete = FALSE; exited = TRUE; }
    /* An interrupted walk proves nothing about unloads: keep what is known. */
    if (complete) {
        unsigned kept = 0;
        for (unsigned i = 0; i < inventory.count; ++i) {
            INVENTORY_IMAGE *image = &inventory.images[i];
            if (!image->seen) {
                ++removed;
                /* An image still waiting for its check is reported unloaded right after its own event. */
                INVENTORY_PENDING *pending = inventory_find_pending(image->base, image->path_hash);
                if (pending) pending->unloaded = TRUE;
                else inventory_emit_unloaded(scan, image->name, image->kind, image->base);
                continue;
            }
            if (kept != i) inventory.images[kept] = *image;
            ++kept;
        }
        inventory.count = kept;
    } else ++inventory.failed_scans;
    inventory.added_total += added;
    inventory.removed_total += removed;
    BOOL present = FALSE;
    int debugger = CheckRemoteDebuggerPresent(target_process, &present) ? (present ? 1 : 0) : -1;
    if (debugger == 1) inventory.debugger_seen = TRUE;
    unsigned same_name = 0;
    BOOL same_known = inventory_same_name(&same_name);
    if (same_known) {
        if (!inventory.same_name_known || same_name > inventory.same_name_max) inventory.same_name_max = same_name;
        inventory.same_name_known = TRUE;
    }
    QueryPerformanceCounter(&end);
    double scan_ms = (double)(end.QuadPart - begin.QuadPart) * 1000.0 / (double)frequency.QuadPart;
    if (scan_ms > inventory.max_scan_ms) inventory.max_scan_ms = scan_ms;
    BOOL changed = first || added || removed || !complete || debugger != inventory.debugger_last
        || (same_known && same_name != inventory.same_name_last);
    inventory.debugger_last = debugger;
    if (same_known) inventory.same_name_last = same_name;
    if (!changed) return;
    char same_text[16] = "null", error_text[48] = "";
    if (same_known) snprintf(same_text, sizeof(same_text), "%u", same_name);
    if (exited) snprintf(error_text, sizeof(error_text), ",\"reason\":\"process-exited\"");
    else if (!complete) snprintf(error_text, sizeof(error_text), ",\"win32Error\":%lu", (unsigned long)error);
    emit("module-inventory", ",\"scan\":%u,\"complete\":%s,\"images\":%u,\"system\":%u,\"windows\":%u,\"game\":%u,\"other\":%u,\"unnamed\":%u,\"withoutValidSignature\":%u,\"pendingChecks\":%u,\"added\":%u,\"removed\":%u,\"debuggerPresent\":%s,\"sameNameProcesses\":%s,\"scanMs\":%.1f%s",
        scan, complete ? "true" : "false", images, counts[INVENTORY_SYSTEM], counts[INVENTORY_WINDOWS], counts[INVENTORY_GAME],
        counts[INVENTORY_OTHER], unnamed, without_signature, inventory_queue.count, added, removed,
        debugger < 0 ? "null" : debugger ? "true" : "false", same_text, scan_ms, error_text);
}

static void inventory_begin(void) {
    DWORD length = PATH_CAP;
    if (!QueryFullProcessImageNameW(target_process, 0, inventory.image_path, &length) || !length) {
        emit("module-inventory-failed", ",\"reason\":\"query-image-name\",\"win32Error\":%lu", (unsigned long)GetLastError());
        return;
    }
    inventory.image_name = basename_w(inventory.image_path);
    if (inventory.image_name == inventory.image_path) {
        emit("module-inventory-failed", ",\"reason\":\"image-directory\"");
        return;
    }
    inventory.game_length = (size_t)(inventory.image_name - inventory.image_path) - 1;
    DWORD windows_length = GetWindowsDirectoryW(inventory.windows_dir, MAX_PATH);
    if (!windows_length || windows_length >= MAX_PATH) {
        emit("module-inventory-failed", ",\"reason\":\"windows-directory\",\"win32Error\":%lu", (unsigned long)GetLastError());
        return;
    }
    inventory.windows_length = inventory_trim(inventory.windows_dir);
    /* Most specific first: TEMP usually sits inside LOCALAPPDATA, both inside the profile. */
    inventory_add_root(L"TEMP", "temp");
    inventory_add_root(L"TMP", "temp");
    inventory_add_root(L"LOCALAPPDATA", "app-data");
    inventory_add_root(L"APPDATA", "app-data");
    inventory_add_root(L"USERPROFILE", "user-profile");
    inventory_add_root(L"ProgramFiles", "program-files");
    inventory_add_root(L"ProgramFiles(x86)", "program-files");
    inventory_add_root(L"ProgramW6432", "program-files");
    inventory_add_root(L"ProgramData", "program-data");
    inventory.debugger_last = -2;
    inventory.next_scan = GetTickCount64() + INVENTORY_FIRST_SCAN_MS;
    inventory.enabled = TRUE;
}

/* Called from the watch loop every ~100 ms: never more than one check budget of work per call. */
static void inventory_tick(void) {
    if (!inventory.enabled) return;
    if (inventory_queue.count) { inventory_drain(INVENTORY_CHECK_BUDGET_MS, TRUE); return; }
    if (GetTickCount64() < inventory.next_scan) return;
    /* The watch loop sees the exit next; a walk now would only fail. */
    if (WaitForSingleObject(target_process, 0) != WAIT_TIMEOUT) return;
    inventory_scan();
    inventory.next_scan = GetTickCount64() + INVENTORY_INTERVAL_MS;
}

static void inventory_end(const char *reason) {
    if (!inventory.enabled) return;
    inventory.enabled = FALSE;
    unsigned unchecked = inventory_queue.count;
    /* Ending: write what is still queued without reading files, so the exit is not held up. */
    while (inventory_queue.count) inventory_drain(0.0, FALSE);
    char same_text[16] = "null";
    if (inventory.same_name_known) snprintf(same_text, sizeof(same_text), "%u", inventory.same_name_max);
    emit("module-inventory-summary", ",\"reason\":\"%s\",\"scans\":%u,\"failedScans\":%u,\"trackedImages\":%u,\"untrackedImages\":%u,\"uncheckedAtEnd\":%u,\"addedTotal\":%llu,\"removedTotal\":%llu,\"debuggerSeen\":%s,\"sameNameProcessesMax\":%s,\"maxScanMs\":%.1f,\"eventLimitReached\":%s",
        reason, inventory.scans, inventory.failed_scans, inventory.count, inventory.untracked, unchecked,
        (unsigned long long)inventory.added_total, (unsigned long long)inventory.removed_total,
        inventory.debugger_seen ? "true" : "false", same_text, inventory.max_scan_ms,
        inventory.event_limit_reached ? "true" : "false");
}

#endif
