/**
 * Monta a DANFSe (Documento Auxiliar da NFS-e) a partir do XML nacional
 * (http://www.sped.fazenda.gov.br/nfse), como um documento HTML completo e
 * autossuficiente — pronto para exibir em <iframe srcdoc>, imprimir ou abrir
 * em outra aba.
 *
 * Dois leiautes:
 *  - `nacional`  — réplica da DANFSe v2.0 (usado nas notas de Manaus/AM);
 *  - `municipal` — leiaute enxuto no estilo da NFS-e paulistana (usado nas
 *    notas de São Paulo / fora do estado).
 */
;(function (global) {
  'use strict'

  const OP_SIMP_NAC = {
    1: 'Não Optante',
    2: 'Optante - Microempreendedor Individual (MEI)',
    3: 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
  }
  const TRIB_ISSQN = {
    1: 'Operação Tributável',
    2: 'Exportação de Serviços',
    3: 'Não Incidência',
    4: 'Imunidade',
    5: 'Não Tributável',
  }
  const TP_RET_ISSQN = { 1: 'Retido pelo Tomador', 2: 'Não Retido', 3: 'Retido pelo Intermediário' }
  const C_STAT = { 100: 'NFS-e Gerada', 107: 'NFS-e Gerada (sem exigência de ISSQN)' }
  const MUN_IBGE = {
    1302603: 'Manaus / AM',
    3550308: 'São Paulo / SP',
    3543402: 'Ribeirão Preto / SP',
    2304400: 'Fortaleza / CE',
    1301902: 'Iranduba / AM',
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

  function childByName(parent, tag) {
    if (!parent) return null
    for (const c of parent.children) if (c.localName === tag || c.nodeName === tag) return c
    return null
  }

  function firstEl(parent, tag) {
    if (!parent) return null
    const els = parent.getElementsByTagName(tag)
    return els.length ? els[0] : null
  }

  function num(raw) {
    if (raw == null || raw === '') return null
    const n = parseFloat(String(raw).replace(',', '.'))
    return isNaN(n) ? null : n
  }

  function money(raw, { zero } = {}) {
    const n = num(raw)
    if (n == null) return zero ? 'R$ 0,00' : '-'
    return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  function pct(raw) {
    const n = num(raw)
    return n == null ? '-' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '%'
  }

  function dt(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`
    const d = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return d ? `${d[3]}/${d[2]}/${d[1]}` : (iso || '-')
  }

  function d(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '-')
  }

  function chaveFmt(digits) {
    const s = String(digits || '').replace(/\D/g, '')
    return s.replace(/(.{4})/g, '$1 ').trim()
  }

  function cnpjFmt(v) {
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

  function tribNacFmt(c) {
    const s = String(c || '').replace(/\D/g, '')
    return s.length === 6 ? `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4, 6)}` : (c || '-')
  }

  function nbsFmt(c) {
    const s = String(c || '').replace(/\D/g, '')
    return s.length === 9 ? `${s[0]}.${s.slice(1, 5)}.${s.slice(5, 7)}.${s.slice(7, 9)}` : (c || '-')
  }

  function munNome(cod) {
    return MUN_IBGE[Number(cod)] || (cod ? `IBGE ${cod}` : '-')
  }

  function or(v, alt) {
    return v == null || v === '' ? (alt || '-') : v
  }

  // -------------------------------------------------------------------
  // Parse
  // -------------------------------------------------------------------

  function parse(xmlText) {
    const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    const infNFSe = firstEl(doc, 'infNFSe')
    if (!infNFSe) return null

    const emit = childByName(infNFSe, 'emit')
    const emitEnd = firstEl(emit, 'enderNac')
    const valNFSe = childByName(infNFSe, 'valores')
    const infDPS = firstEl(infNFSe, 'infDPS')
    const prest = firstEl(infDPS, 'prest')
    const regTrib = firstEl(prest, 'regTrib')
    const toma = firstEl(infDPS, 'toma')
    const tomaEnd = firstEl(toma, 'end')
    const serv = firstEl(infDPS, 'serv')
    const cServ = firstEl(serv, 'cServ')
    const dpsValores = childByName(infDPS, 'valores')
    const trib = firstEl(dpsValores, 'trib')
    const tribMun = firstEl(trib, 'tribMun')
    const tribFed = firstEl(trib, 'tribFed')
    const piscofins = firstEl(tribFed, 'piscofins')
    const totTrib = firstEl(trib, 'totTrib')
    const infoCompl = firstEl(serv, 'infoCompl')
    const totCIBS = firstEl(infNFSe, 'totCIBS')

    return {
      chave: String(infNFSe.getAttribute('Id') || '').replace(/\D/g, ''),
      nNFSe: txt(infNFSe, 'nNFSe'),
      nDFSe: txt(infNFSe, 'nDFSe'),
      dCompet: txt(infDPS, 'dCompet'),
      dhProc: txt(infNFSe, 'dhProc'),
      dhEmiDPS: txt(infDPS, 'dhEmi'),
      nDPS: txt(infDPS, 'nDPS'),
      serie: txt(infDPS, 'serie'),
      cStat: txt(infNFSe, 'cStat'),
      ambGer: txt(infNFSe, 'ambGer'),
      tpAmb: txt(infDPS, 'tpAmb'),
      verAplic: txt(infNFSe, 'verAplic'),
      xLocEmi: txt(infNFSe, 'xLocEmi'),
      xLocPrestacao: txt(infNFSe, 'xLocPrestacao'),
      xLocIncid: txt(infNFSe, 'xLocIncid'),
      cLocIncid: txt(infNFSe, 'cLocIncid'),

      prest: {
        cnpj: txt(emit, 'CNPJ') || txt(prest, 'CNPJ'),
        cpf: txt(emit, 'CPF') || txt(prest, 'CPF'),
        im: (txt(emit, 'IM') || txt(prest, 'IM')).trim(),
        nome: txt(emit, 'xNome'),
        fone: txt(emit, 'fone') || txt(prest, 'fone'),
        email: txt(emit, 'email') || txt(prest, 'email'),
        lgr: txt(emitEnd, 'xLgr'),
        nro: txt(emitEnd, 'nro'),
        compl: txt(emitEnd, 'xCpl'),
        bairro: txt(emitEnd, 'xBairro'),
        cMun: txt(emitEnd, 'cMun'),
        uf: txt(emitEnd, 'UF'),
        cep: txt(emitEnd, 'CEP'),
      },
      opSimpNac: txt(regTrib, 'opSimpNac'),
      regApTribSN: txt(regTrib, 'regApTribSN'),

      toma: {
        cnpj: txt(toma, 'CNPJ'),
        cpf: txt(toma, 'CPF'),
        im: txt(toma, 'IM'),
        nome: txt(toma, 'xNome'),
        fone: txt(toma, 'fone'),
        email: txt(toma, 'email'),
        lgr: txt(tomaEnd, 'xLgr'),
        nro: txt(tomaEnd, 'nro'),
        compl: txt(tomaEnd, 'xCpl'),
        bairro: txt(tomaEnd, 'xBairro'),
        cMun: txt(firstEl(tomaEnd, 'endNac'), 'cMun'),
        cep: txt(firstEl(tomaEnd, 'endNac'), 'CEP'),
      },

      xTribNac: txt(infNFSe, 'xTribNac'),
      xTribMun: txt(infNFSe, 'xTribMun'),
      xNBS: txt(infNFSe, 'xNBS'),
      cTribNac: txt(cServ, 'cTribNac'),
      cTribMun: txt(cServ, 'cTribMun'),
      cNBS: txt(cServ, 'cNBS'),
      xDescServ: txt(cServ, 'xDescServ'),

      vBC: txt(valNFSe, 'vBC'),
      pAliqAplic: txt(valNFSe, 'pAliqAplic'),
      vISSQN: txt(valNFSe, 'vISSQN'),
      vLiq: txt(valNFSe, 'vLiq'),
      vTotalRet: txt(valNFSe, 'vTotalRet'),
      tribISSQN: txt(tribMun, 'tribISSQN'),
      tpRetISSQN: txt(tribMun, 'tpRetISSQN'),
      pAliqMun: txt(tribMun, 'pAliq'),

      vRetIRRF: txt(tribFed, 'vRetIRRF'),
      vRetCP: txt(tribFed, 'vRetCP'),
      vRetCSLL: txt(tribFed, 'vRetCSLL'),
      vPis: txt(piscofins, 'vPis'),
      vCofins: txt(piscofins, 'vCofins'),
      pAliqPis: txt(piscofins, 'pAliqPis'),
      pAliqCofins: txt(piscofins, 'pAliqCofins'),
      tpRetPisCofins: txt(piscofins, 'tpRetPisCofins'),

      pTotTribSN: txt(totTrib, 'pTotTribSN'),
      vTotTribFed: txt(totTrib, 'vTotTribFed'),
      vTotTribEst: txt(totTrib, 'vTotTribEst'),
      vTotTribMun: txt(totTrib, 'vTotTribMun'),
      pTotTribFed: txt(totTrib, 'pTotTribFed'),
      pTotTribEst: txt(totTrib, 'pTotTribEst'),
      pTotTribMun: txt(totTrib, 'pTotTribMun'),

      vServ: txt(infDPS, 'vServ'),
      vTotNF: txt(totCIBS, 'vTotNF'),
      vIBSTot: txt(totCIBS, 'vIBSTot'),
      vCBS: txt(totCIBS, 'vCBS'),

      xInfComp: txt(infoCompl, 'xInfComp'),
    }
  }

  // -------------------------------------------------------------------
  // Blocos reutilizáveis
  // -------------------------------------------------------------------

  function endereco(p) {
    const parts = [
      [p.lgr, p.nro].filter(Boolean).join(', '),
      p.compl,
      p.bairro,
    ].filter((x) => x && x.trim())
    return parts.join(' - ') || '-'
  }

  function field(label, value, cls) {
    return `<div class="fld ${cls || ''}"><span class="lbl">${esc(label)}</span><span class="val">${value == null || value === '' ? '-' : esc(value)}</span></div>`
  }

  function sectionBar(title) {
    return `<div class="bar">${esc(title)}</div>`
  }

  // -------------------------------------------------------------------
  // Leiaute NACIONAL (DANFSe v2.0)
  // -------------------------------------------------------------------

  function renderNacional(m, opts) {
    const situacao = opts.cancelada
      ? 'NFS-e Cancelada'
      : C_STAT[Number(m.cStat)] || `NFS-e (cStat ${m.cStat || '-'})`

    const totTrib = m.pTotTribSN
      ? `Totais aproximados dos Tributos (Simples Nacional) cfe. Lei nº 12.741/2012: ${pct(m.pTotTribSN)}`
      : `Totais aproximados dos Tributos cfe. Lei nº 12.741/2012 — Federais: ${money(m.vTotTribFed, { zero: true })}; Estaduais: ${money(m.vTotTribEst, { zero: true })}; Municipais: ${money(m.vTotTribMun, { zero: true })}`

    return `
    ${opts.cancelada ? '<div class="watermark">CANCELADA</div>' : ''}
    <div class="head">
      <div class="head-logo"><b>NFS</b>e<span>Nota Fiscal de Serviço eletrônica</span></div>
      <div class="head-title"><b>DANFSe v2.0</b><span>Documento Auxiliar da NFS-e</span></div>
      <div class="head-mun">
        <div>Município: ${esc(m.xLocEmi || munNome(m.prest.cMun))}</div>
        <div>Ambiente Gerador: ${esc(or(m.ambGer))}</div>
        <div>Tipo de Ambiente: ${esc(or(m.tpAmb))}</div>
      </div>
    </div>

    <div class="chave">
      <span class="lbl">CHAVE DE ACESSO DA NFS-e</span>
      <span class="val">${esc(chaveFmt(m.chave))}</span>
    </div>

    <div class="grid g3">
      ${field('NÚMERO DA NFS-e', m.nNFSe)}
      ${field('COMPETÊNCIA DA NFS-e', d(m.dCompet))}
      ${field('DATA E HORA DA EMISSÃO DA NFS-e', dt(m.dhProc))}
      ${field('NÚMERO DA DPS', m.nDPS)}
      ${field('SÉRIE DA DPS', m.serie)}
      ${field('DATA E HORA DA EMISSÃO DA DPS', dt(m.dhEmiDPS))}
      ${field('EMITENTE DA NFS-e', 'Prestador')}
      ${field('SITUAÇÃO DA NFS-e', situacao)}
      ${field('Nº DFS-e', m.nDFSe)}
    </div>

    ${sectionBar('PRESTADOR / FORNECEDOR')}
    <div class="grid g3">
      ${field('CNPJ / CPF / NIF', cnpjFmt(m.prest.cnpj || m.prest.cpf))}
      ${field('Inscrição Municipal', m.prest.im)}
      ${field('Telefone', m.prest.fone)}
      ${field('Nome / Nome Empresarial', m.prest.nome, 'wide')}
      ${field('Município / UF', `${or(m.xLocEmi)} / ${or(m.prest.uf)}`)}
      ${field('CEP', cepFmt(m.prest.cep))}
      ${field('Endereço', endereco(m.prest), 'wide')}
      ${field('E-mail', m.prest.email)}
      ${field('Regime Simples Nacional', OP_SIMP_NAC[Number(m.opSimpNac)] || or(m.opSimpNac))}
    </div>

    ${sectionBar('TOMADOR / ADQUIRENTE')}
    <div class="grid g3">
      ${field('CNPJ / CPF / NIF', cnpjFmt(m.toma.cnpj || m.toma.cpf))}
      ${field('Inscrição Municipal', m.toma.im)}
      ${field('Telefone', m.toma.fone)}
      ${field('Nome / Nome Empresarial', m.toma.nome, 'wide')}
      ${field('Município / UF', munNome(m.toma.cMun))}
      ${field('CEP', cepFmt(m.toma.cep))}
      ${field('Endereço', endereco(m.toma), 'wide')}
      ${field('E-mail', m.toma.email)}
      ${field('', '')}
    </div>

    ${sectionBar('SERVIÇO PRESTADO')}
    <div class="grid g3">
      ${field('Serviço', m.xTribNac)}
      ${field('Código de Tributação Nacional / Municipal', `${tribNacFmt(m.cTribNac)}${m.cTribMun ? ' / ' + m.cTribMun : ''}`)}
      ${field('Código da NBS', nbsFmt(m.cNBS))}
    </div>
    <div class="grid g1">
      ${field('Local da Prestação', `${or(m.xLocPrestacao)}${m.xLocIncid ? ' — Incidência: ' + m.xLocIncid : ''}`)}
      <div class="fld wide block"><span class="lbl">Descrição do Serviço</span><span class="val pre">${esc(m.xDescServ)}</span></div>
    </div>

    ${sectionBar('TRIBUTAÇÃO MUNICIPAL (ISSQN)')}
    <div class="grid g3">
      ${field('Tipo de Tributação do ISSQN', TRIB_ISSQN[Number(m.tribISSQN)] || or(m.tribISSQN))}
      ${field('Município de Incidência do ISSQN', `${or(m.xLocIncid)}`)}
      ${field('Retenção do ISSQN', TP_RET_ISSQN[Number(m.tpRetISSQN)] || or(m.tpRetISSQN))}
      ${field('Base de Cálculo do ISSQN', money(m.vBC, { zero: true }))}
      ${field('Alíquota Aplicada', pct(m.pAliqAplic || m.pAliqMun))}
      ${field('ISSQN Apurado', money(m.vISSQN, { zero: true }))}
    </div>

    ${sectionBar('TRIBUTAÇÃO FEDERAL')}
    <div class="grid g3">
      ${field('IRRF Retido', money(m.vRetIRRF, { zero: true }))}
      ${field('Contribuição Previdenciária Retida', money(m.vRetCP, { zero: true }))}
      ${field('CSLL Retida', money(m.vRetCSLL, { zero: true }))}
      ${field('PIS', money(m.vPis, { zero: true }))}
      ${field('COFINS', money(m.vCofins, { zero: true }))}
      ${field('PIS/COFINS/CSLL', num(m.vPis) || num(m.vCofins) ? 'Retidos' : 'Não Retidos')}
    </div>

    ${(num(m.vIBSTot) != null || num(m.vCBS) != null || num(m.vTotNF) != null) ? `
    ${sectionBar('TRIBUTAÇÃO IBS / CBS')}
    <div class="grid g3">
      ${field('Valor Total do IBS', money(m.vIBSTot, { zero: true }))}
      ${field('Valor Total da CBS', money(m.vCBS, { zero: true }))}
      ${field('Valor Total da NFS-e + IBS/CBS', money(m.vTotNF))}
    </div>` : ''}

    ${sectionBar('VALOR TOTAL DA NFS-e')}
    <div class="grid g3">
      ${field('Valor do Serviço', money(m.vServ || m.vBC, { zero: true }), 'strong')}
      ${field('Total das Retenções (ISSQN / Federais)', money(m.vTotalRet, { zero: true }))}
      ${field('Valor Líquido da NFS-e', money(m.vLiq, { zero: true }), 'strong')}
    </div>

    ${sectionBar('INFORMAÇÕES COMPLEMENTARES')}
    <div class="info">
      ${m.xInfComp ? `<p>${esc(m.xInfComp)}</p>` : ''}
      <p>${esc(totTrib)}</p>
      <p class="muted">Chave de acesso: ${esc(m.chave)} · Verificação no portal nacional da NFS-e (www.nfse.gov.br).</p>
    </div>`
  }

  // -------------------------------------------------------------------
  // Leiaute MUNICIPAL (estilo NFS-e paulistana)
  // -------------------------------------------------------------------

  function renderMunicipal(m, opts) {
    const linhas = [
      m.xInfComp,
      `Esta NFS-e substitui a DPS nº ${or(m.nDPS)} Série ${or(m.serie)}, emitida em ${d(m.dhEmiDPS)}.`,
      `Totais aproximados dos Tributos cfe. Lei nº 12.741/2012 — Federais: ${money(m.vTotTribFed, { zero: true })}; Estaduais: ${money(m.vTotTribEst, { zero: true })}; Municipais: ${money(m.vTotTribMun, { zero: true })}${m.pTotTribSN ? ` (Simples Nacional: ${pct(m.pTotTribSN)})` : ''}.`,
    ].filter(Boolean)

    return `
    ${opts.cancelada ? '<div class="watermark">CANCELADA</div>' : ''}
    <div class="head head--mun">
      <div>
        <div class="mun-pref">PREFEITURA DO MUNICÍPIO DE ${esc((m.xLocEmi || '').toUpperCase())}</div>
        <div class="mun-sub">SECRETARIA MUNICIPAL DA FAZENDA</div>
        <div class="mun-tit">NOTA FISCAL ELETRÔNICA DE SERVIÇOS — NFS-e</div>
      </div>
      <div class="head-mun">
        <div>Número da Nota: <b>${esc(or(m.nNFSe))}</b></div>
        <div>Emissão: ${esc(dt(m.dhProc))}</div>
        <div>Nº DFS-e: ${esc(or(m.nDFSe))}</div>
        <div>DPS nº ${esc(or(m.nDPS))} Série ${esc(or(m.serie))} — ${esc(d(m.dhEmiDPS))}</div>
      </div>
    </div>

    <div class="chave">
      <span class="lbl">CHAVE DE ACESSO DA NFS-e</span>
      <span class="val">${esc(chaveFmt(m.chave))}</span>
    </div>

    ${sectionBar('PRESTADOR DE SERVIÇOS')}
    <div class="grid g2">
      ${field('CPF / CNPJ', cnpjFmt(m.prest.cnpj || m.prest.cpf))}
      ${field('Inscrição Municipal', m.prest.im)}
      ${field('Nome / Razão Social', m.prest.nome, 'wide')}
      ${field('Endereço', `${endereco(m.prest)} — CEP ${cepFmt(m.prest.cep)}`, 'wide')}
      ${field('Município', `${or(m.xLocEmi)} / ${or(m.prest.uf)}`)}
      ${field('E-mail', m.prest.email)}
    </div>

    ${sectionBar('TOMADOR DE SERVIÇOS')}
    <div class="grid g2">
      ${field('CPF / CNPJ', cnpjFmt(m.toma.cnpj || m.toma.cpf))}
      ${field('Inscrição Municipal', m.toma.im)}
      ${field('Nome / Razão Social', m.toma.nome, 'wide')}
      ${field('Endereço', `${endereco(m.toma)} — CEP ${cepFmt(m.toma.cep)}`, 'wide')}
      ${field('Município', munNome(m.toma.cMun))}
      ${field('E-mail', m.toma.email)}
    </div>

    ${sectionBar('DISCRIMINAÇÃO DOS SERVIÇOS')}
    <div class="grid g1">
      <div class="fld wide block"><span class="val pre">${esc(m.xDescServ)}</span></div>
    </div>
    <div class="grid g1">
      ${field('Código do Serviço', `${tribNacFmt(m.cTribNac)}${m.cTribMun ? ' / ' + m.cTribMun : ''} — ${or(m.xTribNac || m.xTribMun)}`)}
    </div>

    ${sectionBar('VALOR TOTAL DO SERVIÇO = ' + money(m.vServ || m.vBC, { zero: true }))}
    <div class="grid g3">
      ${field('IRRF', money(m.vRetIRRF, { zero: true }))}
      ${field('CSLL', money(m.vRetCSLL, { zero: true }))}
      ${field('Contrib. Previdenciária', money(m.vRetCP, { zero: true }))}
      ${field('PIS/PASEP', money(m.vPis, { zero: true }))}
      ${field('COFINS', money(m.vCofins, { zero: true }))}
      ${field('Retenções (total)', money(m.vTotalRet, { zero: true }))}
    </div>
    <div class="grid g3">
      ${field('Base de Cálculo', money(m.vBC, { zero: true }))}
      ${field('Alíquota', pct(m.pAliqAplic || m.pAliqMun))}
      ${field('Valor do ISS', money(m.vISSQN, { zero: true }))}
      ${field('ISS', TP_RET_ISSQN[Number(m.tpRetISSQN)] || or(m.tpRetISSQN))}
      ${field('Município de Incidência', or(m.xLocIncid))}
      ${field('Valor Líquido', money(m.vLiq, { zero: true }), 'strong')}
    </div>

    ${sectionBar('OUTRAS INFORMAÇÕES')}
    <div class="info">
      ${linhas.map((l) => `<p>${esc(l)}</p>`).join('')}
      <p class="muted">Chave de acesso: ${esc(m.chave)}</p>
    </div>`
  }

  // -------------------------------------------------------------------
  // CSS do documento
  // -------------------------------------------------------------------

  const CSS = `
    *{box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0;padding:14px;background:#fff}
    .danfse{max-width:900px;margin:0 auto;border:1.5px solid #111;position:relative}
    .watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:80px;font-weight:800;color:rgba(180,35,24,.14);letter-spacing:.1em;pointer-events:none;z-index:5}
    .head{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-bottom:1.5px solid #111}
    .head-logo{font-size:20px;color:#1a7a3a;line-height:1}
    .head-logo b{font-size:24px}
    .head-logo span{display:block;font-size:8px;color:#444}
    .head-title{text-align:center;flex:1}
    .head-title b{display:block;font-size:14px}
    .head-title span{font-size:10px}
    .head-mun{font-size:9px;text-align:right;line-height:1.5}
    .head--mun .mun-pref{font-weight:700;font-size:12px}
    .head--mun .mun-sub{font-size:10px}
    .head--mun .mun-tit{font-weight:700;font-size:11px;margin-top:2px}
    .chave{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-bottom:1px solid #111}
    .chave .lbl{font-size:8px;font-weight:700;color:#555;text-transform:uppercase}
    .chave .val{font-size:12px;letter-spacing:.06em;font-family:"Courier New",monospace}
    .bar{background:#e8e8e8;border-top:1px solid #111;border-bottom:1px solid #111;padding:3px 10px;font-weight:700;font-size:10px;text-transform:uppercase}
    .grid{display:grid}
    .grid.g1{grid-template-columns:1fr}
    .grid.g2{grid-template-columns:1fr 1fr}
    .grid.g3{grid-template-columns:1fr 1fr 1fr}
    .fld{border-right:1px solid #ccc;border-bottom:1px solid #ccc;padding:3px 8px;min-height:30px;display:flex;flex-direction:column;justify-content:center}
    .fld.wide{grid-column:1 / -1}
    .fld .lbl{font-size:8px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.02em}
    .fld .val{font-size:11px;margin-top:1px}
    .fld.strong .val{font-weight:700;font-size:12px}
    .fld.block{min-height:auto}
    .val.pre{white-space:pre-wrap;line-height:1.45;padding:2px 0}
    .info{padding:6px 10px;font-size:9.5px;line-height:1.5}
    .info p{margin:0 0 4px}
    .info .muted{color:#777;font-size:8.5px;word-break:break-all}
    @media print{body{padding:0}.danfse{border:none}}
  `

  // -------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------

  function pickLayout(m, opts) {
    if (opts && opts.layout) return opts.layout
    const uf = String((opts && opts.uf) || m.prest.uf || '').toUpperCase()
    return uf === 'AM' ? 'nacional' : 'municipal'
  }

  function buildHtml(xmlText, opts) {
    const o = opts || {}
    const m = parse(xmlText)
    if (!m) {
      return `<!doctype html><meta charset="utf-8"><body style="font-family:Arial;padding:24px">
        <p>Não foi possível montar a DANFSe: XML da NFS-e ausente ou inválido.</p></body>`
    }
    const layout = pickLayout(m, o)
    const inner = layout === 'nacional' ? renderNacional(m, o) : renderMunicipal(m, o)
    return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
      <title>DANFSe ${esc(m.nNFSe || m.chave)}</title><style>${CSS}</style></head>
      <body><div class="danfse">${inner}</div></body></html>`
  }

  global.ServicosDanfse = { parse, buildHtml, pickLayout }
})(typeof window !== 'undefined' ? window : globalThis)
