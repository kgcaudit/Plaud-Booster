// DOCX(zip) 안의 파일 하나를 꺼낸다. 압축 해제는 브라우저 내장 DecompressionStream을 쓴다.

/** @param {Uint8Array} buf @param {string} want */
export async function readZipEntry(buf, want) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 끝에서 중앙 디렉터리 끝 레코드(0x06054b50)를 찾는다
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 형식이 아닙니다");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    if (name === want) {
      const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      if (method === 0) return data;
      if (method !== 8) throw new Error("지원하지 않는 압축 방식");
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${want} 이(가) 없습니다`);
}
