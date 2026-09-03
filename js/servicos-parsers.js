/**
 * Leitura dos arquivos da conciliação de serviços:
 *
 *  - Lote de NFS-e: um .zip (como o baixado no portal nacional da NFS-e) ou
 *    vários .xml soltos. Cada XML é uma NFS-e no layout nacional
 *    (http://www.sped.fazenda.gov.br/nfse). As notas dentro de uma pasta
 *    "Canceladas" entram marcadas como canceladas.
 *  - Arquivo do sistema: o XLSX de entradas com tipo "serviço" — mesmo
 *    layout do arquivo do Moura, então reaproveita o parser de
 *    `ConciliacaoParsers`.
 *
 * Usa JSZip (window.JSZip) para o .zip e o DOMParser nativo para os XML.
 */
;(function (global) {
  'use strict'

  const Parsers = global.ConciliacaoParsers
  const Base = global.ConciliacaoEngine

  class ServicosImportError extends Error {}

  const MSG_ZIP_INVALIDO =
    'Arquivo inválido. Envie o .zip de NFS-e baixado no portal ou os .xml das notas.'
  const MSG_ZIP_VAZIO = 'Nenhuma NFS-e válida foi encontrada nos arquivos enviados.'
  const MSG_XML_INVALIDO = 'Não foi possível interpretar este XML como uma NFS-e.'

  // -----------------------------------------------------------------------
  // Helpers de XML
  // -----------------------------------------------------------------------

  function txt(parent, tag) {
    if (!parent) return ''
    const els = parent.getElementsByTagName(tag)
    return els.length ? String(els[0].textContent || '').trim() : ''
  }

  function directChild(parent, tag) {
    if (!parent) return null
    for (const c of parent.children) {
      if (c.localName === tag || c.nodeName === tag) return c
    }
    return null
  }

  function firstEl(parent, tag) {
    if (!parent) return null
    const els = parent.getElementsByTagName(tag)
    return els.length ? els[0] : null
  }

  function readAs(file, how) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      if (how === 'text') reader.readAsText(file)
      else reader.readAsArrayBuffer(file)
    })
  }

  function reformatarDataISO(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '')
  }

  // Remove os blocos <Signature> (assinatura + certificado) — não são usados
  // para montar a DANFSe e representam ~metade do tamanho do XML.
  function stripSignatures(xmlText) {
    return String(xmlText || '')
      .replace(/<(\w+:)?Signature[\s\S]*?<\/(\w+:)?Signature>/g, '')
      .trim()
  }

  // Constrói a linha normalizada a partir do texto de um XML de NFS-e.
  function nfseRowFromXmlString(xmlText, meta) {
    const info = meta || {}
    let doc
    try {
      doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    } catch (e) {
      throw new ServicosImportError(MSG_XML_INVALIDO)
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) {
      throw new ServicosImportError(MSG_XML_INVALIDO)
    }

    const infNFSe = firstEl(doc, 'infNFSe')
    if (!infNFSe) throw new ServicosImportError(MSG_XML_INVALIDO)

    const emit = directChild(infNFSe, 'emit')
    const valoresNfse = directChild(infNFSe, 'valores')
    const infDPS = firstEl(infNFSe, 'infDPS')
    const cServ = firstEl(infDPS, 'cServ')
    const tribMun = firstEl(infDPS, 'tribMun')
    const vServEl = firstEl(infDPS, 'vServ')

    const chave = String(infNFSe.getAttribute('Id') || '').replace(/\D/g, '')
    const prestadorCnpj = Base.normalizeCNPJ(txt(emit, 'CNPJ') || txt(firstEl(infDPS, 'prest'), 'CNPJ'))

    const valorServicoBruto = Base.normalizeValor(
      vServEl ? vServEl.textContent : ''
    )
    const valorLiquido = Base.normalizeValor(txt(valoresNfse, 'vLiq'))
    const iss = Base.normalizeValor(txt(valoresNfse, 'vISSQN'))
    const tpRet = txt(tribMun, 'tpRetISSQN')
    const temIss = iss > 0

    const dhEmi = txt(infDPS, 'dhEmi') || txt(infNFSe, 'dhProc')

    const row = {
      chave,
      numero: Base.stripQuotes(txt(infNFSe, 'nNFSe')),
      dps: Base.stripQuotes(txt(infDPS, 'nDPS')),
      serie: Base.stripQuotes(txt(infDPS, 'serie')),
      emissao: Base.parseDateBR(dhEmi),
      emissaoRaw: reformatarDataISO(dhEmi),
      competencia: reformatarDataISO(txt(infDPS, 'dCompet')),
      prestadorCnpj,
      prestadorCnpjFormatado: Base.formatCNPJ(prestadorCnpj),
      prestador: Base.stripQuotes(txt(emit, 'xNome')),
      municipio: Base.stripQuotes(txt(infNFSe, 'xLocEmi')),
      uf: Base.stripQuotes(txt(emit, 'UF')).toUpperCase(),
      codServico: Base.stripQuotes(txt(cServ, 'cTribNac')),
      descricao: Base.stripQuotes(txt(cServ, 'xDescServ')).replace(/\s+/g, ' '),
      valorServico: valorServicoBruto || valorLiquido,
      valorLiquido: valorLiquido || valorServicoBruto,
      iss,
      issAliquota: Base.normalizeValor(txt(valoresNfse, 'pAliqAplic') || txt(tribMun, 'pAliq')),
      issRetido: temIss && tpRet === '1',
      temIss,
      cStat: Base.stripQuotes(txt(infNFSe, 'cStat')),
      cancelada: !!info.cancelada,
      arquivo: info.arquivo || '',
      // XML sem as assinaturas — usado para montar a DANFSe sob demanda
      xml: stripSignatures(xmlText),
    }

    if (!row.numero && !row.chave) throw new ServicosImportError(MSG_XML_INVALIDO)
    return row
  }

  // Reconstrói as linhas a partir de objetos simples (importação de .json).
  // As datas voltam como string ISO.
  function nfseRowsFromPlain(list) {
    return (list || []).map((r) => {
      const emissao = r.emissao ? Base.parseDateBR(r.emissao) : null
      return Object.assign({}, r, {
        emissao,
        prestadorCnpj: Base.normalizeCNPJ(r.prestadorCnpj || ''),
        prestadorCnpjFormatado:
          r.prestadorCnpjFormatado || Base.formatCNPJ(Base.normalizeCNPJ(r.prestadorCnpj || '')),
        valorServico: Base.normalizeValor(r.valorServico),
        valorLiquido: Base.normalizeValor(r.valorLiquido),
        iss: Base.normalizeValor(r.iss),
        temIss: Base.normalizeValor(r.iss) > 0,
        issRetido: !!r.issRetido,
        cancelada: !!r.cancelada,
      })
    })
  }

  // -----------------------------------------------------------------------
  // Lote de NFS-e (.zip ou .xml soltos)
  // -----------------------------------------------------------------------

  function isXmlName(name) {
    return /\.xml$/i.test(name)
  }

  function isCanceladaPath(path) {
    // pasta "Canceladas" em qualquer nível — o .zip do portal usa "/", mas
    // outros compactadores gravam "\".
    return /(^|[\\/])cancel\w*[\\/]/i.test(String(path || ''))
  }

  function baseName(path) {
    return String(path || '').split(/[\\/]/).pop()
  }

  function dedupeRows(rows) {
    const vistos = new Set()
    const out = []
    for (const row of rows) {
      const id = row.chave || `${row.prestadorCnpj}|${row.numero}|${row.serie}`
      if (vistos.has(id)) {
        // mantém a versão cancelada se aparecer duplicada
        if (row.cancelada) {
          const alvo = out.find((r) => (r.chave || `${r.prestadorCnpj}|${r.numero}|${r.serie}`) === id)
          if (alvo) alvo.cancelada = true
        }
        continue
      }
      vistos.add(id)
      out.push(row)
    }
    return out
  }

  async function parseNfseLote(file) {
    if (!file) throw new ServicosImportError(MSG_ZIP_INVALIDO)

    if (isXmlName(file.name)) {
      const row = safeRow(await readAs(file, 'text'), { arquivo: file.name, cancelada: false })
      if (!row) throw new ServicosImportError(MSG_ZIP_VAZIO)
      return { rows: [row], fileName: file.name, rejeitados: 0 }
    }

    const buffer = await readAs(file, 'buffer')
    const bytes = new Uint8Array(buffer.slice(0, 4))
    const ehZip = bytes[0] === 0x50 && bytes[1] === 0x4b
    if (!ehZip) throw new ServicosImportError(MSG_ZIP_INVALIDO)
    if (!global.JSZip) throw new ServicosImportError('Biblioteca de leitura de .zip indisponível.')

    let zip
    try {
      zip = await global.JSZip.loadAsync(buffer)
    } catch (e) {
      throw new ServicosImportError(MSG_ZIP_INVALIDO)
    }

    const entradas = []
    zip.forEach((path, entry) => {
      if (!entry.dir && isXmlName(path)) entradas.push({ path, entry })
    })
    if (!entradas.length) throw new ServicosImportError(MSG_ZIP_VAZIO)

    const rows = []
    let rejeitados = 0
    for (const { path, entry } of entradas) {
      const xmlText = await entry.async('string')
      const row = safeRow(xmlText, {
        arquivo: baseName(path),
        cancelada: isCanceladaPath(path),
      })
      if (row) rows.push(row)
      else rejeitados += 1
    }

    const finais = dedupeRows(rows)
    if (!finais.length) throw new ServicosImportError(MSG_ZIP_VAZIO)
    return { rows: finais, fileName: file.name, rejeitados }
  }

  async function parseNfseXmls(fileList) {
    const files = Array.from(fileList || [])
    const rows = []
    let rejeitados = 0
    for (const f of files) {
      if (!isXmlName(f.name)) continue
      const row = safeRow(await readAs(f, 'text'), { arquivo: f.name, cancelada: false })
      if (row) rows.push(row)
      else rejeitados += 1
    }
    const finais = dedupeRows(rows)
    if (!finais.length) throw new ServicosImportError(MSG_ZIP_VAZIO)
    return { rows: finais, fileName: `${files.length} arquivo(s) XML`, rejeitados }
  }

  function safeRow(xmlText, meta) {
    if (!String(xmlText || '').trim()) return null
    try {
      return nfseRowFromXmlString(xmlText, meta)
    } catch (e) {
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Arquivo do sistema (entradas de serviço) — mesmo layout do Moura
  // -----------------------------------------------------------------------

  async function parseSistemaServicos(file) {
    return Parsers.parseSistemaXlsx(file)
  }

  global.ServicosParsers = {
    ServicosImportError,
    parseNfseLote,
    parseNfseXmls,
    parseSistemaServicos,
    nfseRowFromXmlString,
    nfseRowsFromPlain,
    sistemaRowsFromMatrix: Parsers.sistemaRowsFromMatrix,
    MSG_ZIP_INVALIDO,
    MSG_ZIP_VAZIO,
    MSG_XML_INVALIDO,
  }
})(typeof window !== 'undefined' ? window : globalThis)
