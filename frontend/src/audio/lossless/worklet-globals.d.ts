// Minimal AudioWorkletGlobalScope typings (not included in TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      params: Record<string, Float32Array>,
    ): boolean;
  },
): void;
