// pkt-line framing and sideband multiplexing, as git's smart HTTP transport
// defines them. A pkt-line is a 4-hex-digit length (payload length plus the 4
// header bytes) followed by the payload; `0000` is a flush packet, `0001` a
// delimiter, `0002` a response end. Sideband prefixes each payload with a band
// byte: 1 for data, 2 for progress, 3 for errors.

export const MAX_PACKET = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > MAX_PACKET) throw new Error(`pkt-line payload of ${body.length} bytes exceeds the 65516-byte limit`);
  const header = Buffer.allocUnsafe(4);
  header.write(total.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

/**
 * Parse pkt-lines from the start of a buffer. Stops after the first flush,
 * delimiter or response-end packet and returns the unconsumed remainder, so a
 * receive-pack body yields its command lines and then the raw pack bytes.
 * Throws on a malformed length, a length below 4, or a truncated packet.
 */
export function parsePktLines(
  buffer: Buffer,
): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PktLineError(`truncated pkt-line header at offset ${offset}`);
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new PktLineError(`invalid pkt-line header ${JSON.stringify(header)} at offset ${offset}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      break;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      break;
    }
    if (length < 4) throw new PktLineError(`pkt-line length ${length} is below the minimum of 4`);
    if (offset + length > buffer.length) {
      throw new PktLineError(`truncated pkt-line of ${length} bytes at offset ${offset}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Parse every pkt-line in a buffer that contains nothing else; no remainder may survive. */
export function parseAllPktLines(buffer: Buffer): PktPacket[] {
  const parsed = parsePktLines(buffer);
  if (parsed.rest.length > 0) throw new PktLineError(`${parsed.rest.length} stray bytes after the pkt-line stream`);
  return parsed.packets;
}

/**
 * Parse a packet stream that may contain delimiters mid-stream (protocol v2
 * requests): delimiters and response-ends are collected as packets and
 * parsing continues until the first flush or the end of the buffer.
 */
export function parsePktStream(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PktLineError(`truncated pkt-line header at offset ${offset}`);
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new PktLineError(`invalid pkt-line header ${JSON.stringify(header)} at offset ${offset}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4) throw new PktLineError(`pkt-line length ${length} is below the minimum of 4`);
    if (offset + length > buffer.length) {
      throw new PktLineError(`truncated pkt-line of ${length} bytes at offset ${offset}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** The data packets' payloads, decoded as UTF-8 text. */
export function packetTexts(packets: readonly PktPacket[]): string[] {
  const texts: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') texts.push(packet.payload.toString('utf8'));
  }
  return texts;
}

/** Split a byte stream into sideband band-1 pkt-lines of at most `maxData` payload bytes each. */
export function sidebandData(data: Buffer, maxData = 65515): Buffer {
  if (data.length === 0) return pktLine(Buffer.from([1]));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxData) {
    const slice = data.subarray(offset, offset + maxData);
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(framed));
  }
  return Buffer.concat(chunks);
}

/** One sideband band-2 (progress) line. */
export function sidebandProgress(text: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(text, 'utf8')]));
}

/** One sideband band-3 (error) line. */
export function sidebandError(text: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]));
}

/** Concatenate several pkt-line fragments into one body. */
export function concatPkt(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}
