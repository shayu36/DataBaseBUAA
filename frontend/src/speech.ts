export const VOICE_MESSAGES = {
  login: "欢迎使用北京航空航天大学青行校园共享自行车管理系统",
  unlock: "开锁成功，祝您骑行愉快",
  returnSuccess: "还车成功，感谢您的使用",
  returnUnavailable: "当前位置无法还车，请前往指定停车点归还",
  logout: "感谢使用青行校园共享自行车管理系统，期待您下次使用",
} as const;

const preferredVoiceNames = [
  "Microsoft Xiaoxiao Online (Natural)",
  "Microsoft Xiaoyi Online (Natural)",
  "Microsoft Xiaoxiao",
  "Microsoft Xiaoyi",
  "Ting-Ting",
];

function chooseChineseVoice(voices: SpeechSynthesisVoice[]) {
  for (const name of preferredVoiceNames) {
    const voice = voices.find((candidate) => candidate.name.includes(name));
    if (voice) return voice;
  }
  return voices.find((voice) => /^zh(?:-|_)/i.test(voice.lang)) || null;
}

export function speakAnnouncement(message: string) {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  )
    return;

  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "zh-CN";
  utterance.rate = 0.94;
  utterance.pitch = 1.02;
  utterance.volume = 0.96;
  utterance.voice = chooseChineseVoice(window.speechSynthesis.getVoices());
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function announcementForOperation(path: string, succeeded: boolean) {
  if (path === "/rides/start")
    return succeeded ? VOICE_MESSAGES.unlock : undefined;
  if (/^\/rides\/\d+\/return$/.test(path))
    return succeeded
      ? VOICE_MESSAGES.returnSuccess
      : VOICE_MESSAGES.returnUnavailable;
  return undefined;
}
