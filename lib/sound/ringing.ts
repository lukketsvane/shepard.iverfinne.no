/**
 * The notes and hits that are sounding or scheduled, so that Stop can end them all: left alone
 * they ring on for seconds, and in a suspended context they would wait there for the next Play.
 */
export class Ringing {
  private sources = new Set<AudioScheduledSourceNode>();

  /** Track a source that has been started. It forgets itself when it ends. */
  add(source: AudioScheduledSourceNode): void {
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /** End every source at context time `when`. */
  stopAll(when: number): void {
    for (const source of this.sources) source.stop(when);
    this.sources.clear();
  }
}
