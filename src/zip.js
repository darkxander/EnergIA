// Lecteur zip minimal, sans dépendance : lit le répertoire central puis
// décompresse une entrée à la demande (le fichier n'est jamais chargé en entier).

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const Z64_LOCATOR = 0x07064b50;
const Z64_EOCD = 0x06064b50;

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const u64 = (dv, offset) => Number(dv.getBigUint64(offset, true));

export async function listZipEntries(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await view(blob, blob.size - tailLen, blob.size);
  let p = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { p = i; break; }
  }
  if (p < 0) throw new Error("Ce fichier n'est pas une archive zip valide.");

  let cdSize = tail.getUint32(p + 12, true);
  let cdOffset = tail.getUint32(p + 16, true);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (p >= 20 && tail.getUint32(p - 20, true) === Z64_LOCATOR) {
      const recordOffset = u64(tail, p - 20 + 8);
      const record = await view(blob, recordOffset, recordOffset + 56);
      if (record.getUint32(0, true) === Z64_EOCD) {
        cdSize = u64(record, 40);
        cdOffset = u64(record, 48);
      }
    }
  }

  const cd = await view(blob, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries = [];
  let o = 0;
  while (o + 46 <= cd.byteLength && cd.getUint32(o, true) === CEN) {
    const method = cd.getUint16(o + 10, true);
    let compSize = cd.getUint32(o + 20, true);
    let size = cd.getUint32(o + 24, true);
    const nameLen = cd.getUint16(o + 28, true);
    const extraLen = cd.getUint16(o + 30, true);
    const commentLen = cd.getUint16(o + 32, true);
    let offset = cd.getUint32(o + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + o + 46, nameLen));

    // Champ supplémentaire zip64 : valeurs 64 bits pour les champs saturés.
    let e = o + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); }
      }
      e += 4 + len;
    }

    entries.push({ name, method, compSize, size, offset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntryText(blob, entry) {
  const header = await view(blob, entry.offset, entry.offset + 30);
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = blob.slice(start, start + entry.compSize);
  if (entry.method === 0) return data.text();
  if (entry.method === 8) {
    const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }
  throw new Error(`Méthode de compression non prise en charge (${entry.method}).`);
}
