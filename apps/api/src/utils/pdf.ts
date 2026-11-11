/* 纯文本PDF：把已转成字符串的文档行排版为A4，不执行HTML、不加载外部链接。
 * 调用：response.type('application/pdf').send(pdf('合同记录',['客户：张三','正文……']))。
 * 合同和开票记录共用；中文使用PDF预定义简体中文字体，源文本另保存在业务快照中。
 */
export function pdf(title:string,lines:string[]):Buffer {
  const wrapped:string[]=[]; // 每页保持固定行距，长文字不会溢出纸张
  for(const paragraph of [title,'',...lines].join('\n').split('\n')) {
    let line='',width=0;
    for(const character of paragraph.replace(/[\u0000-\u0008\u000b-\u001f]/g,'')) {
      const size=character.codePointAt(0)!<128?0.55:1;
      if(width+size>44){wrapped.push(line);line='';width=0;}
      line+=character;width+=size;
    }
    wrapped.push(line);
  }
  const pages:string[][]=[];
  for(let index=0;index<wrapped.length;index+=44)pages.push(wrapped.slice(index,index+44));
  const objects:Buffer[]=[]; // 对象编号从1开始，xref使用实际字节偏移
  const add=(value:string|Buffer)=>{objects.push(Buffer.isBuffer(value)?value:Buffer.from(value));return objects.length;};
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${5+i*2} 0 R`).join(' ')}] >>`);
  add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>');
  add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
  for(const page of pages) {
    const pageId=objects.length+1;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId+1} 0 R >>`);
    const commands=['BT /F1 11 Tf 16 TL 42 792 Td',...page.map(line=>`<${Buffer.from(line,'utf16le').swap16().toString('hex')}> Tj T*`),'ET'].join('\n');
    const data=Buffer.from(commands);
    add(Buffer.concat([Buffer.from(`<< /Length ${data.length} >>\nstream\n`),data,Buffer.from('\nendstream')]));
  }
  const chunks=[Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n','binary')],offsets=[0];
  let position=chunks[0].length;
  objects.forEach((object,i)=>{
    offsets.push(position);
    const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);
    chunks.push(chunk);position+=chunk.length;
  });
  const xref=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}
