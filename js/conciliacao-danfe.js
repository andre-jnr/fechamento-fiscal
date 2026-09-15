/**
 * Monta a DANFE (Documento Auxiliar da Nota Fiscal Eletrônica — produto/mercadoria,
 * modelo 55) a partir do XML padrão da NF-e (http://www.portalfiscal.inf.br/nfe),
 * como um documento HTML completo e autossuficiente — pronto para exibir em
 * <iframe srcdoc>, imprimir ou abrir em outra aba. Réplica do leiaute clássico do
 * DANFE (canhoto + cabeçalho + dados do emitente/destinatário/transportador +
 * tabela de produtos), no espírito do que `servicos-danfse.js` já faz para a NFS-e.
 *
 * Só existe XML disponível quando o "sistema" veio do conector-erp (fetch direto no
 * banco, que traz `Conteudo_Arquivo_Xml`) — upload manual do XLSX nunca tem esse
 * campo, então o botão de abrir a DANFE só aparece nesses casos (ver
 * `js/conciliacao-app.js`, `danfeCell`).
 */
;(function (global) {
  'use strict'

  const TP_NF = { 0: 'ENTRADA', 1: 'SAÍDA' }
  const MOD_FRETE = {
    0: 'Contratação do Frete por conta do Remetente (CIF)',
    1: 'Contratação do Frete por conta do Destinatário (FOB)',
    2: 'Contratação do Frete por conta de Terceiros',
    3: 'Transporte Próprio por conta do Remetente',
    4: 'Transporte Próprio por conta do Destinatário',
    9: 'Sem Ocorrência de Transporte',
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  function txt(parent, tag) {
    if (!parent) return ''
    const els = parent.getElementsByTagName(tag)
    return els.length ? String(els[0].textContent || '').trim() : ''
  }

  function firstEl(parent, tag) {
    if (!parent) return null
    const els = parent.getElementsByTagName(tag)
    return els.length ? els[0] : null
  }

  function allEls(parent, tag) {
    if (!parent) return []
    return Array.from(parent.getElementsByTagName(tag))
  }

  function num(raw) {
    if (raw == null || raw === '') return null
    const n = parseFloat(String(raw).replace(',', '.'))
    return isNaN(n) ? null : n
  }

  function money(raw, { zero } = {}) {
    const n = num(raw)
    if (n == null) return zero ? '0,00' : '-'
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  function qtd(raw) {
    const n = num(raw)
    return n == null ? '-' : n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
  }

  function pct(raw) {
    const n = num(raw)
    return n == null ? '-' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  function dt(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`
    const d = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return d ? `${d[3]}/${d[2]}/${d[1]}` : (iso || '-')
  }

  function d(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
  }

  function hora(iso) {
    const m = String(iso || '').match(/[T ](\d{2}):(\d{2})/)
    return m ? `${m[1]}:${m[2]}` : ''
  }

  function chaveFmt(digits) {
    const s = String(digits || '').replace(/\D/g, '')
    return s.replace(/(.{4})/g, '$1 ').trim()
  }

  function cnpjCpfFmt(v) {
    const dgt = String(v || '').replace(/\D/g, '')
    if (dgt.length === 14) {
      return `${dgt.slice(0, 2)}.${dgt.slice(2, 5)}.${dgt.slice(5, 8)}/${dgt.slice(8, 12)}-${dgt.slice(12)}`
    }
    if (dgt.length === 11) {
      return `${dgt.slice(0, 3)}.${dgt.slice(3, 6)}.${dgt.slice(6, 9)}-${dgt.slice(9)}`
    }
    return v || '-'
  }

  function cepFmt(v) {
    const dgt = String(v || '').replace(/\D/g, '')
    return dgt.length === 8 ? `${dgt.slice(0, 5)}-${dgt.slice(5)}` : (v || '-')
  }

  function or(v, alt) {
    return v == null || v === '' ? (alt != null ? alt : '-') : v
  }

  // -------------------------------------------------------------------
  // Parse
  // -------------------------------------------------------------------

  function endereco(end) {
    return {
      lgr: txt(end, 'xLgr'),
      nro: txt(end, 'nro'),
      compl: txt(end, 'xCpl'),
      bairro: txt(end, 'xBairro'),
      mun: txt(end, 'xMun'),
      uf: txt(end, 'UF'),
      cep: txt(end, 'CEP'),
      fone: txt(end, 'fone'),
    }
  }

  function icmsInfo(det) {
    const imposto = firstEl(det, 'imposto')
    const icms = firstEl(imposto, 'ICMS')
    if (!icms) return { orig: '', cst: '', vBC: '', pICMS: '', vICMS: '' }
    // O grupo real (ICMS00, ICMS10, ICMS20..., ICMSSN101, ICMSSN102...) é o único
    // filho direto de <ICMS> — pega ele por posição em vez de listar todos os nomes.
    const grupo = icms.children && icms.children.length ? icms.children[0] : icms
    return {
      orig: txt(grupo, 'orig'),
      cst: txt(grupo, 'CST') || txt(grupo, 'CSOSN'),
      vBC: txt(grupo, 'vBC'),
      pICMS: txt(grupo, 'pICMS'),
      vICMS: txt(grupo, 'vICMS'),
    }
  }

  function ipiInfo(det) {
    const imposto = firstEl(det, 'imposto')
    const ipi = firstEl(imposto, 'IPI')
    const trib = firstEl(ipi, 'IPITrib')
    return { pIPI: txt(trib, 'pIPI') }
  }

  function parse(xmlText) {
    const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    const infNFe = firstEl(doc, 'infNFe')
    if (!infNFe) return null

    const ide = firstEl(infNFe, 'ide')
    const emit = firstEl(infNFe, 'emit')
    const enderEmit = firstEl(emit, 'enderEmit')
    const dest = firstEl(infNFe, 'dest')
    const enderDest = firstEl(dest, 'enderDest')
    const total = firstEl(infNFe, 'total')
    const icmsTot = firstEl(total, 'ICMSTot')
    const transp = firstEl(infNFe, 'transp')
    const transporta = firstEl(transp, 'transporta')
    const veicTransp = firstEl(transp, 'veicTransp')
    const vol = firstEl(transp, 'vol')
    const infAdic = firstEl(infNFe, 'infAdic')
    const infProt = firstEl(doc, 'infProt')

    const dets = allEls(infNFe, 'det').map((det) => {
      const prod = firstEl(det, 'prod')
      const icms = icmsInfo(det)
      const ipi = ipiInfo(det)
      return {
        cProd: txt(prod, 'cProd'),
        xProd: txt(prod, 'xProd'),
        NCM: txt(prod, 'NCM'),
        CFOP: txt(prod, 'CFOP'),
        uCom: txt(prod, 'uCom'),
        qCom: txt(prod, 'qCom'),
        vUnCom: txt(prod, 'vUnCom'),
        vProd: txt(prod, 'vProd'),
        orig: icms.orig,
        cst: icms.cst,
        vBCIcms: icms.vBC,
        vICMS: icms.vICMS,
        pICMS: icms.pICMS,
        pIPI: ipi.pIPI,
      }
    })

    return {
      chave: String(infNFe.getAttribute('Id') || '').replace(/\D/g, ''),
      natOp: txt(ide, 'natOp'),
      nNF: txt(ide, 'nNF'),
      serie: txt(ide, 'serie'),
      dhEmi: txt(ide, 'dhEmi') || txt(ide, 'dEmi'),
      dhSaiEnt: txt(ide, 'dhSaiEnt') || txt(ide, 'dSaiEnt'),
      tpNF: txt(ide, 'tpNF'),
      tpAmb: txt(ide, 'tpAmb'),

      emit: {
        cnpj: txt(emit, 'CNPJ'),
        cpf: txt(emit, 'CPF'),
        nome: txt(emit, 'xNome'),
        fant: txt(emit, 'xFant'),
        ie: txt(emit, 'IE'),
        iest: txt(emit, 'IEST'),
        ...endereco(enderEmit),
      },

      dest: {
        cnpj: txt(dest, 'CNPJ'),
        cpf: txt(dest, 'CPF'),
        nome: txt(dest, 'xNome'),
        ie: txt(dest, 'IE'),
        ...endereco(enderDest),
      },

      det: dets,

      total: {
        vBC: txt(icmsTot, 'vBC'),
        vICMS: txt(icmsTot, 'vICMS'),
        vBCST: txt(icmsTot, 'vBCST'),
        vST: txt(icmsTot, 'vST'),
        vII: txt(icmsTot, 'vII'),
        vPIS: txt(icmsTot, 'vPIS'),
        vFrete: txt(icmsTot, 'vFrete'),
        vSeg: txt(icmsTot, 'vSeg'),
        vDesc: txt(icmsTot, 'vDesc'),
        vOutro: txt(icmsTot, 'vOutro'),
        vIPI: txt(icmsTot, 'vIPI'),
        vCOFINS: txt(icmsTot, 'vCOFINS'),
        vProd: txt(icmsTot, 'vProd'),
        vNF: txt(icmsTot, 'vNF'),
      },

      transp: {
        modFrete: txt(transp, 'modFrete'),
        transportaNome: txt(transporta, 'xNome'),
        transportaCnpj: txt(transporta, 'CNPJ') || txt(transporta, 'CPF'),
        transportaIe: txt(transporta, 'IE'),
        transportaEnd: txt(transporta, 'xEnder'),
        transportaMun: txt(transporta, 'xMun'),
        transportaUf: txt(transporta, 'UF'),
        placa: txt(veicTransp, 'placa'),
        placaUf: txt(veicTransp, 'UF'),
        antt: txt(veicTransp, 'RNTC'),
        qVol: txt(vol, 'qVol'),
        esp: txt(vol, 'esp'),
        marca: txt(vol, 'marca'),
        nVol: txt(vol, 'nVol'),
        pesoL: txt(vol, 'pesoL'),
        pesoB: txt(vol, 'pesoB'),
      },

      infCpl: txt(infAdic, 'infCpl'),

      protocolo: infProt ? `${txt(infProt, 'nProt')} - ${dt(txt(infProt, 'dhRecbto'))}` : '',
      cStat: txt(infProt, 'cStat'),
    }
  }

  // -------------------------------------------------------------------
  // Blocos reutilizáveis
  // -------------------------------------------------------------------

  function field(label, value, opts) {
    const o = opts || {}
    const style = o.span ? ` style="grid-column: span ${o.span}"` : ''
    return `<div class="fld ${o.cls || ''}"${style}><span class="lbl">${esc(label)}</span><span class="val">${value == null || value === '' ? '' : esc(value)}</span></div>`
  }

  function enderecoLinha(e) {
    return [e.lgr, e.nro].filter(Boolean).join(', ') + (e.compl ? ' - ' + e.compl : '')
  }

  // Código de barras decorativo (não é um CODE-128 real, só uma reprodução visual
  // determinística a partir dos dígitos da chave — o mesmo espírito do resto do
  // documento: ajuda a conferir visualmente, a autenticação de verdade é feita no
  // portal da NF-e a partir da chave de acesso, já exibida em texto ao lado).
  function barcodeSvg(digits) {
    const s = String(digits || '').replace(/\D/g, '') || '0'
    let bars = ''
    let x = 0
    for (let i = 0; i < s.length; i++) {
      const n = Number(s[i])
      const w = 1 + (n % 3)
      if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="40" fill="#000"/>`
      x += w + 1
    }
    return `<svg viewBox="0 0 ${x} 40" preserveAspectRatio="none" class="barcode">${bars}</svg>`
  }

  // -------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------

  function render(m, opts) {
    const o = opts || {}
    const tipo = TP_NF[Number(m.tpNF)] || '-'
    const modFreteLabel = MOD_FRETE[Number(m.transp.modFrete)] || (m.transp.modFrete || '-')

    const produtos = m.det.length
      ? m.det.map((p) => `
        <tr>
          <td>${esc(p.cProd)}</td>
          <td class="desc">${esc(p.xProd)}</td>
          <td>${esc(p.NCM)}</td>
          <td>${esc(`${or(p.orig, '')}${or(p.cst, '')}`)}</td>
          <td>${esc(p.CFOP)}</td>
          <td>${esc(p.uCom)}</td>
          <td class="num">${qtd(p.qCom)}</td>
          <td class="num">${money(p.vUnCom, { zero: true })}</td>
          <td class="num">${money(p.vProd, { zero: true })}</td>
          <td class="num">${money(p.vBCIcms, { zero: true })}</td>
          <td class="num">${money(p.vICMS, { zero: true })}</td>
          <td class="num">${pct(p.pICMS)}</td>
          <td class="num">${p.pIPI ? pct(p.pIPI) : '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="13" class="muted" style="text-align:center">Sem itens no XML</td></tr>'

    return `
    ${o.cancelada ? '<div class="watermark">CANCELADA</div>' : ''}
    <div class="canhoto">
      <div class="canhoto-txt">
        RECEBEMOS DE ${esc(m.emit.nome || '-')} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL
        ELETRÔNICA INDICADA ABAIXO. EMISSÃO: ${esc(d(m.dhEmi))} VALOR TOTAL: R$ ${money(m.total.vNF, { zero: true })}
        ${esc(m.emit.mun || '')}${m.emit.uf ? '-' + esc(m.emit.uf) : ''}
        <div class="canhoto-assinatura">
          <span>DATA DE RECEBIMENTO</span>
          <span>IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR</span>
        </div>
      </div>
      <div class="canhoto-nf">
        <b>NF-e</b>
        <span>Nº ${esc(or(m.nNF))}</span>
        <span>Série ${esc(or(m.serie))}</span>
      </div>
    </div>

    <div class="head3">
      <div class="head-emit">
        <div class="head-emit-nome">${esc(m.emit.nome || m.emit.fant || '-')}</div>
        <div class="head-emit-end">${esc(enderecoLinha(m.emit))}</div>
        <div class="head-emit-end">${esc(m.emit.bairro || '')} - ${esc(m.emit.mun || '')} - ${esc(m.emit.uf || '')}</div>
        <div class="head-emit-end">${m.emit.fone ? 'Fone/Fax: ' + esc(m.emit.fone) : ''}</div>
      </div>
      <div class="head-danfe">
        <b>DANFE</b>
        <span>Documento Auxiliar da Nota Fiscal Eletrônica</span>
        <div class="head-danfe-tipo">
          <div>${esc(tipo === 'ENTRADA' ? '0' : '1')} - ${esc(tipo)}</div>
        </div>
        <div class="head-danfe-num">Nº ${esc(or(m.nNF)).padStart(9, '0')}</div>
        <div>Série ${esc(or(m.serie))}</div>
      </div>
      <div class="head-chave">
        ${barcodeSvg(m.chave)}
        <div class="chave-txt">CHAVE DE ACESSO</div>
        <div class="chave-val">${esc(chaveFmt(m.chave))}</div>
        <div class="chave-consulta">Consulta de autenticidade no portal nacional da NF-e<br/>www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora</div>
      </div>
    </div>

    <div class="grid g2">
      ${field('Natureza da Operação', m.natOp, { span: 1 })}
      ${field('Protocolo de Autorização de Uso', m.protocolo)}
    </div>
    <div class="grid g3">
      ${field('Inscrição Estadual', m.emit.ie)}
      ${field('Inscrição Estadual do Subst. Tribut.', m.emit.iest)}
      ${field('CNPJ', cnpjCpfFmt(m.emit.cnpj))}
    </div>

    ${sectionBar('DESTINATÁRIO / REMETENTE')}
    <div class="grid g5">
      ${field('Nome / Razão Social', m.dest.nome, { span: 3 })}
      ${field('CNPJ / CPF', cnpjCpfFmt(m.dest.cnpj || m.dest.cpf))}
      ${field('Data da Emissão', d(m.dhEmi))}
      ${field('Endereço', enderecoLinha(m.dest), { span: 2 })}
      ${field('Bairro/Distrito', m.dest.bairro)}
      ${field('CEP', cepFmt(m.dest.cep))}
      ${field('Data da Saída/Entrada', d(m.dhSaiEnt))}
      ${field('Município', m.dest.mun)}
      ${field('UF', m.dest.uf)}
      ${field('Fone/Fax', m.dest.fone)}
      ${field('Inscrição Estadual', m.dest.ie)}
      ${field('Hora da Saída/Entrada', hora(m.dhSaiEnt))}
    </div>

    ${sectionBar('CÁLCULO DO IMPOSTO')}
    <div class="grid g7">
      ${field('Base de Cálculo do ICMS', money(m.total.vBC, { zero: true }))}
      ${field('Valor do ICMS', money(m.total.vICMS, { zero: true }))}
      ${field('Base de Cálc. ICMS S.T.', money(m.total.vBCST, { zero: true }))}
      ${field('Valor do ICMS Subst.', money(m.total.vST, { zero: true }))}
      ${field('Valor Imp. Importação', money(m.total.vII, { zero: true }))}
      ${field('Valor do PIS', money(m.total.vPIS, { zero: true }))}
      ${field('Valor Total dos Produtos', money(m.total.vProd, { zero: true }), { cls: 'strong', span: 1 })}
      ${field('Valor do Frete', money(m.total.vFrete, { zero: true }))}
      ${field('Valor do Seguro', money(m.total.vSeg, { zero: true }))}
      ${field('Desconto', money(m.total.vDesc, { zero: true }))}
      ${field('Outras Despesas', money(m.total.vOutro, { zero: true }))}
      ${field('Valor Total do IPI', money(m.total.vIPI, { zero: true }))}
      ${field('Valor da COFINS', money(m.total.vCOFINS, { zero: true }))}
      ${field('Valor Total da Nota', money(m.total.vNF, { zero: true }), { cls: 'strong', span: 1 })}
    </div>

    ${sectionBar('TRANSPORTADOR / VOLUMES TRANSPORTADOS')}
    <div class="grid g6">
      ${field('Nome / Razão Social', m.transp.transportaNome, { span: 2 })}
      ${field('Frete por Conta', modFreteLabel)}
      ${field('Código ANTT', m.transp.antt)}
      ${field('Placa do Veículo', m.transp.placa)}
      ${field('UF', m.transp.placaUf)}
    </div>
    <div class="grid g5">
      ${field('CNPJ/CPF', m.transp.transportaCnpj ? cnpjCpfFmt(m.transp.transportaCnpj) : '')}
      ${field('Endereço', m.transp.transportaEnd, { span: 2 })}
      ${field('Município', m.transp.transportaMun)}
      ${field('UF', m.transp.transportaUf)}
      ${field('Inscrição Estadual', m.transp.transportaIe)}
    </div>
    <div class="grid g6">
      ${field('Quantidade', m.transp.qVol)}
      ${field('Espécie', m.transp.esp)}
      ${field('Marca', m.transp.marca)}
      ${field('Numeração', m.transp.nVol)}
      ${field('Peso Bruto', m.transp.pesoB)}
      ${field('Peso Líquido', m.transp.pesoL)}
    </div>

    ${sectionBar('DADOS DOS PRODUTOS / SERVIÇOS')}
    <table class="prod-table">
      <thead>
        <tr>
          <th>Código</th><th>Descrição do Produto/Serviço</th><th>NCM/SH</th><th>O/CST</th>
          <th>CFOP</th><th>UN</th><th>Quant</th><th>Valor Unit</th><th>Valor Total</th>
          <th>B. Cálc ICMS</th><th>Valor ICMS</th><th>Alíq ICMS</th><th>Alíq IPI</th>
        </tr>
      </thead>
      <tbody>${produtos}</tbody>
    </table>

    ${sectionBar('DADOS ADICIONAIS')}
    <div class="grid g2 adic">
      <div class="fld block"><span class="lbl">Informações Complementares</span><span class="val pre">${esc(m.infCpl)}</span></div>
      <div class="fld block"><span class="lbl">Reservado ao Fisco</span><span class="val"></span></div>
    </div>
    `
  }

  function sectionBar(title) {
    return `<div class="bar">${esc(title)}</div>`
  }

  // -------------------------------------------------------------------
  // CSS do documento
  // -------------------------------------------------------------------

  const CSS = `
    *{box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#111;margin:0;padding:14px;background:#fff}
    .danfe{max-width:1000px;margin:0 auto;border:1.5px solid #111;position:relative}
    .watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:80px;font-weight:800;color:rgba(180,35,24,.14);letter-spacing:.1em;pointer-events:none;z-index:5}

    .canhoto{display:flex;gap:10px;padding:6px 10px;border-bottom:1px dashed #111}
    .canhoto-txt{flex:1;font-size:9px;line-height:1.5}
    .canhoto-assinatura{display:flex;gap:20px;margin-top:10px;border-top:1px solid #111;padding-top:2px}
    .canhoto-assinatura span{flex:1;font-size:7.5px;color:#555}
    .canhoto-nf{flex-shrink:0;width:150px;text-align:center;border-left:1px solid #111;padding-left:10px}
    .canhoto-nf b{display:block;font-size:15px}
    .canhoto-nf span{display:block;font-size:9px}

    .head3{display:grid;grid-template-columns:1.3fr 1fr 1.4fr;border-bottom:1.5px solid #111}
    .head-emit{padding:8px 10px;border-right:1px solid #111;display:flex;flex-direction:column;justify-content:center}
    .head-emit-nome{font-size:14px;font-weight:700;margin-bottom:3px}
    .head-emit-end{font-size:8.5px;color:#333;line-height:1.4}
    .head-danfe{padding:8px 10px;border-right:1px solid #111;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
    .head-danfe b{font-size:15px}
    .head-danfe span{font-size:8px}
    .head-danfe-tipo{border:1px solid #111;border-radius:3px;padding:2px 6px;margin-top:3px;font-size:9px;font-weight:700}
    .head-danfe-num{font-size:11px;font-weight:700;margin-top:3px}
    .head-chave{padding:8px 10px;display:flex;flex-direction:column;align-items:center;gap:2px}
    .barcode{width:100%;max-width:260px;height:34px}
    .chave-txt{font-size:8px;font-weight:700;color:#555}
    .chave-val{font-size:10.5px;letter-spacing:.05em;font-family:"Courier New",monospace}
    .chave-consulta{font-size:7px;color:#555;text-align:center;line-height:1.3}

    .bar{background:#e8e8e8;border-top:1px solid #111;border-bottom:1px solid #111;padding:3px 10px;font-weight:700;font-size:9.5px;text-transform:uppercase}
    .grid{display:grid}
    .grid.g2{grid-template-columns:2fr 1.4fr}
    .grid.g3{grid-template-columns:repeat(3,1fr)}
    .grid.g5{grid-template-columns:repeat(5,1fr)}
    .grid.g6{grid-template-columns:repeat(6,1fr)}
    .grid.g7{grid-template-columns:repeat(6,1fr) 1.4fr}
    .fld{border-right:1px solid #ccc;border-bottom:1px solid #ccc;padding:3px 6px;min-height:28px;display:flex;flex-direction:column;justify-content:center;overflow:hidden}
    .fld .lbl{font-size:7px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap}
    .fld .val{font-size:10px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fld.strong .val{font-weight:700;font-size:10.5px}
    .fld.block{min-height:auto}
    .val.pre{white-space:pre-wrap;line-height:1.4;padding:2px 0}
    .adic{min-height:60px}

    .prod-table{width:100%;border-collapse:collapse;font-size:8.5px}
    .prod-table th{background:#f2f2f2;border:1px solid #999;padding:3px 4px;font-size:7.5px;text-transform:uppercase;font-weight:700}
    .prod-table td{border:1px solid #ccc;padding:2px 4px;vertical-align:top}
    .prod-table td.desc{max-width:220px}
    .prod-table td.num{text-align:right;white-space:nowrap}
    .prod-table .muted{color:#888}

    @media print{body{padding:0}.danfe{border:none}}
  `

  // -------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------

  function buildHtml(xmlText, opts) {
    const o = opts || {}
    const m = parse(xmlText)
    if (!m) {
      return `<!doctype html><meta charset="utf-8"><body style="font-family:Arial;padding:24px">
        <p>Não foi possível montar a DANFE: XML da NF-e ausente ou inválido.</p></body>`
    }
    const inner = render(m, o)
    return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
      <title>DANFE ${esc(m.nNF || m.chave)}</title><style>${CSS}</style></head>
      <body><div class="danfe">${inner}</div></body></html>`
  }

  global.ConciliacaoDanfe = { parse, buildHtml }
})(typeof window !== 'undefined' ? window : globalThis)
