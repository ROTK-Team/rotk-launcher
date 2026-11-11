import type { DebugReportFailureReason } from "../shared/contracts";
import type { AppLocale } from "../shared/locale";

export interface DiagnosticsCopy {
  debug: {
    title: string;
    enable: string;
    description: string;
    enabled: string;
    saving: string;
    recording: string;
    preparing: string;
    ready: string;
    error: string;
    /** Second line of "error": why the report was not sent. */
    failure: Record<DebugReportFailureReason, string>;
    settingFailed: string;
  };
}

export const DIAGNOSTICS_COPY: Record<AppLocale, DiagnosticsCopy> = {
  en: {
    debug: {
      title: "Debug",
      enable: "Debug and send session reports",
      description: "Enable before playing to send technical logs, performance data and available memory dumps privately to ROTK after your next game. Dumps may contain private data. No screen or microphone recording. Reports are deleted within 7 days. Debug covers one game: it turns itself off once the report has been sent.",
      enabled: "Debug is ready for your next game.",
      saving: "Saving…",
      recording: "Debug is active. Your game session is being recorded.",
      preparing: "Preparing and sending your report…",
      ready: "Report received by ROTK. You can share this reference with an admin:",
      error: "Report not sent. Your evidence is kept locally. Restart the launcher to retry.",
      failure: {
        collection: "Cause: the report could not be prepared on this PC",
        timeout: "Cause: sending took too long",
        network: "Cause: the connection to the ROTK server failed",
        rejected: "Cause: the ROTK server did not accept the report",
        "account-changed": "Cause: the launcher key changed since this game",
        other: "Cause: unexpected error",
      },
      settingFailed: "This setting couldn’t be saved. Try again.",
    },
  },
  fr: {
    debug: {
      title: "Debug",
      enable: "Debug et envoi des rapports",
      description: "À activer avant de jouer pour envoyer à ROTK, en privé après ta prochaine partie, les logs techniques, les performances et les dumps mémoire disponibles. Les dumps peuvent contenir des données privées. Aucun enregistrement de l’écran ou du micro. Rapports supprimés sous 7 jours. Debug vaut pour une partie : il se désactive tout seul une fois le rapport envoyé.",
      enabled: "Debug prêt pour ta prochaine partie.",
      saving: "Enregistrement…",
      recording: "Debug actif. Ta session de jeu est enregistrée.",
      preparing: "Préparation et envoi du rapport…",
      ready: "Rapport reçu par ROTK. Tu peux communiquer cette référence à un admin :",
      error: "Rapport non envoyé. Les données restent sur ton PC. Relance le launcher pour réessayer.",
      failure: {
        collection: "Cause : le rapport n’a pas pu être préparé sur ton PC",
        timeout: "Cause : l’envoi a pris trop de temps",
        network: "Cause : la connexion au serveur ROTK a échoué",
        rejected: "Cause : le serveur ROTK n’a pas accepté le rapport",
        "account-changed": "Cause : la clé launcher a changé depuis cette partie",
        other: "Cause : erreur inattendue",
      },
      settingFailed: "Ce réglage n’a pas pu être enregistré. Réessaie.",
    },
  },
  zh: {
    debug: {
      title: "调试",
      enable: "调试并发送会话报告",
      description: "在游戏前开启，下一局结束后会把技术日志、性能数据和可用的内存转储私下发送给 ROTK。转储可能包含隐私数据。不会录制屏幕或麦克风。报告会在 7 天内删除。调试只对一局游戏有效：报告发送后会自动关闭。",
      enabled: "调试已为下一局游戏准备就绪。",
      saving: "正在保存…",
      recording: "调试已开启，正在记录你的游戏会话。",
      preparing: "正在准备并发送报告…",
      ready: "ROTK 已收到报告。你可以把这个编号发给管理员：",
      error: "报告未发送，数据保留在你的电脑上。重启启动器以重试。",
      failure: {
        collection: "原因：无法在你的电脑上准备报告",
        timeout: "原因：发送耗时过长",
        network: "原因：与 ROTK 服务器的连接失败",
        rejected: "原因：ROTK 服务器未接受该报告",
        "account-changed": "原因：本局游戏之后启动器密钥已更改",
        other: "原因：意外错误",
      },
      settingFailed: "无法保存此设置，请重试。",
    },
  },
};
