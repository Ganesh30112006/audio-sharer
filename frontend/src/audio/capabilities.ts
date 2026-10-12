/**
 * Progressive capability detection. Every feature that depends on a browser
 * API checks here first and degrades to the OS default output when missing.
 * Detection proves an API exists — not that a given device will work with it.
 */
export interface Capabilities {
  secureContext: boolean;
  webrtc: boolean;
  webAudio: boolean;
  mediaDevices: boolean;
  enumerateDevices: boolean;
  /** HTMLMediaElement.setSinkId — route an element to a chosen output. */
  setSinkId: boolean;
  /** MediaDevices.selectAudioOutput — browser picker granting output access (Firefox). */
  selectAudioOutput: boolean;
  /** AudioContext.setSinkId — route a Web Audio graph (Chromium 110+). */
  audioContextSetSinkId: boolean;
  getUserMedia: boolean;
  getDisplayMedia: boolean;
  /**
   * Whether display capture is likely to include audio. Only desktop Chromium
   * delivers tab/system audio today; Firefox and Safari return video only.
   */
  displayAudioLikely: boolean;
  /** jitterBufferTarget on RTCRtpReceiver (stable-buffer mode). */
  jitterBufferTarget: boolean;
  /** iOS/iPadOS: element volume is read-only and output routing is OS-controlled. */
  isIOS: boolean;
  isMobile: boolean;
}

type NavigatorWithUAData = Navigator & {
  userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string }> };
};

export function detectCapabilities(win: Window & typeof globalThis = window): Capabilities {
  const nav = win.navigator as NavigatorWithUAData;
  const md = nav.mediaDevices as (MediaDevices & { selectAudioOutput?: unknown }) | undefined;
  const ua = nav.userAgent ?? '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && (nav.maxTouchPoints ?? 0) > 1);
  const isMobile = nav.userAgentData?.mobile ?? (isIOS || /Android|Mobi/i.test(ua));
  const isChromium =
    nav.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)) ??
    /Chrome\/|Edg\//.test(ua);
  const AudioCtx = win.AudioContext as typeof AudioContext | undefined;
  const Receiver = (win as unknown as { RTCRtpReceiver?: { prototype: object } }).RTCRtpReceiver;
  const getDisplayMedia = typeof md?.getDisplayMedia === 'function';

  return {
    secureContext: win.isSecureContext,
    webrtc: typeof win.RTCPeerConnection === 'function',
    webAudio: typeof AudioCtx === 'function',
    mediaDevices: !!md,
    enumerateDevices: typeof md?.enumerateDevices === 'function',
    setSinkId:
      typeof win.HTMLMediaElement === 'function' && 'setSinkId' in win.HTMLMediaElement.prototype,
    selectAudioOutput: typeof md?.selectAudioOutput === 'function',
    audioContextSetSinkId: !!AudioCtx && 'setSinkId' in AudioCtx.prototype,
    getUserMedia: typeof md?.getUserMedia === 'function',
    getDisplayMedia,
    displayAudioLikely: getDisplayMedia && isChromium && !isMobile,
    jitterBufferTarget: !!Receiver && 'jitterBufferTarget' in Receiver.prototype,
    isIOS,
    isMobile,
  };
}

let cached: Capabilities | undefined;

export function getCapabilities(): Capabilities {
  return (cached ??= detectCapabilities());
}
