import {
  Download,
  PackageOpen,
  RefreshCw,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AppLocale } from "../../shared/locale";
import type { AssetSyncProgress, InstallProgress, LauncherSnapshot } from "../../shared/contracts";
import {
  selectGlobalActivities,
  type GlobalActivity,
} from "../activity-state";
import { useI18n, type Copy } from "../i18n";

interface GlobalActivityCenterProps {
  snapshot: LauncherSnapshot;
}

function formatBytes(value: number, locale: AppLocale): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / (1024 ** index);
  return `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: index === 0 ? 0 : 1,
    minimumFractionDigits: 0,
  }).format(scaled)} ${units[index]}`;
}

function icon(activity: GlobalActivity): ReactNode {
  switch (activity.kind) {
    case "installation": return <PackageOpen size={22} />;
    case "asset-sync": return <Download size={22} />;
    case "integrity": return <ShieldCheck size={22} />;
    case "launch": return <Rocket size={22} />;
    case "launcher-update": return <RefreshCw size={22} />;
  }
}

function title(activity: GlobalActivity, copy: Copy): string {
  switch (activity.kind) {
    case "installation": return copy.activity.installation;
    case "asset-sync": return copy.activity.assets;
    case "integrity": return copy.activity.integrity;
    case "launch": return copy.activity.launch;
    case "launcher-update": return copy.activity.launcherUpdate;
  }
}

function stage(activity: GlobalActivity, copy: Copy): string {
  if (activity.kind === "installation") {
    const installStage = activity.stage as InstallProgress["phase"] | null;
    return installStage ? copy.install.progressPhases[installStage] : copy.footer.installing;
  }
  if (activity.kind === "asset-sync") {
    const assetStage = activity.stage as AssetSyncProgress["phase"] | null;
    return assetStage ? copy.assets.status[assetStage] : copy.assets.updating;
  }
  if (activity.kind === "integrity") return copy.integrity.verifying;
  if (activity.kind === "launch") return copy.footer.preparingClient;
  if (activity.kind === "launcher-update") {
    return activity.stage === "downloading" ? copy.update.downloading : copy.activity.checkingUpdate;
  }
  return copy.activity.working;
}

function detail(activity: GlobalActivity, copy: Copy): string {
  if (activity.detail) return activity.detail;
  switch (activity.kind) {
    case "installation": return copy.activity.preparingFiles;
    case "asset-sync": return copy.activity.checkingAssets;
    case "integrity": return copy.activity.integrityDetail;
    case "launch": return copy.activity.launchDetail;
    case "launcher-update": return copy.activity.updateDetail;
  }
}

function metrics(activity: GlobalActivity, copy: Copy, locale: AppLocale): string[] {
  const values: string[] = [];
  if (activity.completedItems !== null && activity.totalItems !== null) {
    values.push(activity.kind === "asset-sync"
      ? copy.activity.packs(activity.completedItems, activity.totalItems)
      : copy.activity.files(activity.completedItems, activity.totalItems));
  }
  if (activity.completedBytes !== null && activity.totalBytes !== null) {
    values.push(`${formatBytes(activity.completedBytes, locale)} / ${formatBytes(activity.totalBytes, locale)}`);
  }
  return values;
}

export function GlobalActivityCenter({ snapshot }: GlobalActivityCenterProps) {
  const { locale, copy } = useI18n();
  const activities = selectGlobalActivities(snapshot);
  if (activities.length === 0) return null;

  return (
    <section className="activity-center" aria-label={copy.activity.regionLabel}>
      {activities.map((activity) => {
        const activityTitle = title(activity, copy);
        const activityStage = stage(activity, copy);
        const activityMetrics = metrics(activity, copy, locale);
        const percent = activity.progressPercent;
        const roundedPercent = percent === null ? null : Math.round(percent);
        return (
          <article className="activity-card" key={activity.id}>
            <div className="activity-card__icon" aria-hidden="true">{icon(activity)}</div>
            <div className="activity-card__body">
              <div className="activity-card__heading" aria-live="polite" aria-atomic="true">
                <span>{copy.activity.eyebrow} · {activityStage}</span>
                <strong>{activityTitle}</strong>
              </div>
              <small className="activity-card__detail" title={detail(activity, copy)}>
                {detail(activity, copy)}
              </small>
              <div
                className={`activity-card__track${roundedPercent === null ? " is-indeterminate" : ""}`}
                role="progressbar"
                aria-label={copy.activity.progress(activityTitle)}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(roundedPercent === null ? {} : { "aria-valuenow": roundedPercent })}
              >
                <i style={roundedPercent === null ? undefined : { width: `${percent}%` }} />
              </div>
              {activityMetrics.length > 0 && (
                <div className="activity-card__metrics" aria-hidden="true">
                  {activityMetrics.map((value) => <span key={value}>{value}</span>)}
                </div>
              )}
            </div>
            <strong className="activity-card__percent" aria-hidden="true">
              {roundedPercent === null ? "•••" : `${roundedPercent}%`}
            </strong>
          </article>
        );
      })}
    </section>
  );
}
