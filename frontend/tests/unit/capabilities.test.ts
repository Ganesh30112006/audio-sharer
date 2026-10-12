import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/audio/capabilities';

function fakeWindow(opts: {
  ua: string;
  mobile?: boolean;
  sink?: boolean;
  display?: boolean;
  touch?: number;
}) {
  class Media {}
  if (opts.sink)
    (Media.prototype as unknown as Record<string, unknown>).setSinkId = () => undefined;
  return {
    isSecureContext: true,
    RTCPeerConnection: function RTCPeerConnection() {},
    AudioContext: class {},
    HTMLMediaElement: Media,
    navigator: {
      userAgent: opts.ua,
      maxTouchPoints: opts.touch ?? 0,
      userAgentData:
        opts.mobile === undefined
          ? undefined
          : { mobile: opts.mobile, brands: [{ brand: 'Chromium' }] },
      mediaDevices: {
        enumerateDevices: () => Promise.resolve([]),
        getUserMedia: () => Promise.resolve(),
        ...(opts.display ? { getDisplayMedia: () => Promise.resolve() } : {}),
      },
    },
  } as unknown as Window & typeof globalThis;
}

describe('detectCapabilities', () => {
  it('detects desktop Chromium with tab audio and sink selection', () => {
    const caps = detectCapabilities(
      fakeWindow({ ua: 'Mozilla/5.0 Chrome/130.0', mobile: false, sink: true, display: true }),
    );
    expect(caps.setSinkId).toBe(true);
    expect(caps.getDisplayMedia).toBe(true);
    expect(caps.displayAudioLikely).toBe(true);
    expect(caps.selectAudioOutput).toBe(false);
  });

  it('does not promise tab audio on mobile', () => {
    const caps = detectCapabilities(
      fakeWindow({
        ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile',
        mobile: true,
        display: true,
      }),
    );
    expect(caps.isMobile).toBe(true);
    expect(caps.displayAudioLikely).toBe(false);
  });

  it('detects iPadOS posing as macOS', () => {
    const caps = detectCapabilities(
      fakeWindow({
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
        touch: 5,
      }),
    );
    expect(caps.isIOS).toBe(true);
    expect(caps.setSinkId).toBe(false);
    expect(caps.displayAudioLikely).toBe(false);
  });
});
