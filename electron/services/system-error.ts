import { resolve, sep } from "node:path";

// Keep the file path and a likely cause in the message shown to the player.
export function describeSystemError(
  error: NodeJS.ErrnoException,
  bundledResourcesRoot: string | null,
): string {
  const code = error.code ?? "UNKNOWN";
  const path = error.path ?? "";
  const operation = error.syscall ? `, ${error.syscall}` : "";
  const bundled = Boolean(
    bundledResourcesRoot
    && path
    && resolve(path).toLocaleLowerCase("en-US").startsWith(
      `${resolve(bundledResourcesRoot).toLocaleLowerCase("en-US")}${sep}`,
    ),
  );
  if (!path) return `Erreur système (${code}${operation}).`;
  if (code === "ENOENT" && bundled) {
    return `Un fichier du launcher a disparu : ${path}. Ton antivirus l’a probablement mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.`;
  }
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
    return `Accès refusé au fichier ${path} (${code}${operation}) : droits insuffisants, antivirus ou fichier utilisé par un autre programme. Réessaie, vérifie les droits du dossier ou ajoute le dossier ROTK aux exclusions de l’antivirus.`;
  }
  if (code === "ENOSPC") {
    return `Disque plein pendant l’écriture de ${path}. Libère de l’espace puis réessaie.`;
  }
  if (code === "ENOENT") {
    return `Fichier introuvable : ${path}.`;
  }
  return `Erreur système (${code}${operation}) : ${path}.`;
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return error instanceof Error && typeof code === "string" && /^E(?!RR_)[A-Z0-9_]+$/.test(code);
}
