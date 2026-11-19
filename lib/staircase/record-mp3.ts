export async function encodeRecordingMp3(audio: AudioBuffer): Promise<Blob> {
  const { Mp3Encoder } = await import('@_mehrad/lamejs');
  const channels = Math.min(2, audio.numberOfChannels) as 1 | 2;
  const encoder = new Mp3Encoder(channels, audio.sampleRate, 192);
  const left = audio.getChannelData(0);
  const right = channels === 2 ? audio.getChannelData(1) : null;
  const chunks: ArrayBuffer[] = [];
  const block = 1152;
  const pcm = (source: Float32Array, from: number, to: number): Int16Array => {
    const out = new Int16Array(to - from);
    for (let i = from; i < to; i++) {
      const value = Math.max(-1, Math.min(1, source[i]));
      out[i - from] = Math.round(value < 0 ? value * 32768 : value * 32767);
    }
    return out;
  };
  for (let i = 0; i < left.length; i += block) {
    const end = Math.min(i + block, left.length);
    const result = encoder.encodeBuffer(pcm(left, i, end), right ? pcm(right, i, end) : undefined);
    if (result.byteLength) chunks.push(Uint8Array.from(result).buffer);
  }
  const tail = encoder.flush();
  if (tail.byteLength) chunks.push(Uint8Array.from(tail).buffer);
  return new Blob(chunks, { type: 'audio/mpeg' });
}
