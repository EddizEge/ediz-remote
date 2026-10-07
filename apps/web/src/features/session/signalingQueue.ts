export const MAX_PENDING_SIGNAL_MESSAGES = 64
export const MAX_PENDING_SIGNAL_BYTES = 128 * 1024

interface QueuedSignal<T> {
  value: T
  bytes: number
}

export class BoundedSignalQueue<T> {
  private readonly entries: QueuedSignal<T>[] = []
  private totalBytes = 0

  tryEnqueue(value: T): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (
      this.entries.length >= MAX_PENDING_SIGNAL_MESSAGES ||
      this.totalBytes + bytes > MAX_PENDING_SIGNAL_BYTES
    ) return false

    this.entries.push({ value, bytes })
    this.totalBytes += bytes
    return true
  }

  drain(): T[] {
    const values = this.entries.map((entry) => entry.value)
    this.clear()
    return values
  }

  clear(): void {
    this.entries.length = 0
    this.totalBytes = 0
  }

  get size(): number {
    return this.entries.length
  }

  get byteLength(): number {
    return this.totalBytes
  }
}
