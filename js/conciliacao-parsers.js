/**
 * Leitura e validação dos arquivos importados (CSV da SEFAZ e XLSX/XLS do
 * sistema interno). Usa SheetJS (window.XLSX) para os dois formatos.
 */
;(function (global) {
  'use strict'

  const Engine = global.ConciliacaoEngine

  class ConciliacaoImportError extends Error {}

  const MSG_ARQUIVO_INVALIDO =
    'Arquivo inválido. Verifique se o arquivo corresponde ao layout esperado.'
  const MSG_ARQUIVO_VAZIO = 'O arquivo não possui registros para conciliação.'
  const MSG_FORMATO_INVALIDO = 'Não foi possível interpretar os dados deste arquivo.'
  const msgColunaAusente = (nome) =>
    `Não foi possível importar o arquivo porque a coluna "${nome}" não foi encontrada.`

  function normalizeHeader(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  function findColumnIndex(headerRow, candidates, fromIndex) {
    const normalized = headerRow.map(normalizeHeader)
    const wanted = candidates.map(normalizeHeader)
    for (let i = fromIndex || 0; i < normalized.length; i++) {
      if (wanted.includes(normalized[i])) return i
    }
    return -1
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(file)
    })
  }

  function bytesStartWith(bytes, signature) {
    if (bytes.length < signature.length) return false
    for (let i = 0; i < signature.length; i++) {
      if (bytes[i] !== signature[i]) return false
    }
    return true
  }

  function isZipSignature(bytes) {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  }

  function isOleSignature(bytes) {
    return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  }

  // Algumas exportações de Excel gravam um "!ref" (dimensão) desatualizado,
  // menor do que os dados reais da planilha — recalcula a partir das
  // células realmente presentes para não truncar linhas/colunas.
  function fixSheetRange(sheet) {
    let minR = Infinity
    let minC = Infinity
    let maxR = -Infinity
    let maxC = -Infinity
    for (const key of Object.keys(sheet)) {
      if (key[0] === '!') continue
      const addr = global.XLSX.utils.decode_cell(key)
      if (addr.r < minR) minR = addr.r
      if (addr.c < minC) minC = addr.c
      if (addr.r > maxR) maxR = addr.r
      if (addr.c > maxC) maxC = addr.c
    }
    if (maxR === -Infinity) return
    sheet['!ref'] = global.XLSX.utils.encode_range({
      s: { r: minR, c: minC },
      e: { r: maxR, c: maxC },
    })
  }

  // -----------------------------------------------------------------------
  // SEFAZ (CSV)
  // -----------------------------------------------------------------------

  const SEFAZ_REQUIRED_FIELDS = [
    { key: 'uf', names: ['UF'], label: 'UF' },
    { key: 'nf', names: ['NUMERO', 'NF', 'NUMERO NF'], label: 'NF (NUMERO)' },
    { key: 'serie', names: ['SERIE'], label: 'Série' },
    { key: 'emissao', names: ['EMISSAO', 'DATA EMISSAO'], label: 'Emissão' },
    { key: 'cnpjEmissor', names: ['CNPJ EMISSOR'], label: 'CNPJ Emissor' },
    {
      key: 'cnpjDestinatario',
      names: ['CNPJ-CPF DESTINATARIO', 'CNPJ DESTINATARIO', 'CPF-CNPJ DESTINATARIO'],
      label: 'CNPJ/CPF Destinatário',
    },
    { key: 'cfop', names: ['CFOP'], label: 'CFOP' },
    { key: 'situacao', names: ['SITUACAO'], label: 'Situação' },
    { key: 'tipo', names: ['TIPO'], label: 'Tipo' },
    { key: 'valor', names: ['VALOR'], label: 'Valor' },
    { key: 'rejeitada', names: ['REJEITADA'], label: 'Rejeitada' },
  ]

  async function parseSefazCsv(file) {
    let buffer
    try {
      buffer = await readFileAsArrayBuffer(file)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const bytes = new Uint8Array(buffer.slice(0, 8))
    if (isZipSignature(bytes) || isOleSignature(bytes)) {
      // Excel disfarçado de CSV
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    let text
    try {
      text = new TextDecoder('windows-1252').decode(buffer)
    } catch (e) {
      text = new TextDecoder('utf-8').decode(buffer)
    }

    // remove BOM e a linha de pragma "sep=;" usada por exportações do Excel
    text = text.replace(/^﻿/, '')
    text = text.replace(/^sep=.\r?\n/i, '')

    let workbook
    try {
      workbook = global.XLSX.read(text, { type: 'string', FS: ';', raw: true })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    const sheet = workbook.Sheets[sheetName]
    fixSheetRange(sheet)

    let matrix
    try {
      matrix = global.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    const result = sefazRowsFromMatrix(matrix)
    result.fileName = file.name
    return result
  }

  // Reconstrói as linhas normalizadas a partir da matriz bruta (linha 0 =
  // cabeçalho). Usado tanto pelo parser de arquivo quanto pela importação de
  // um arquivo de conciliação (.json), garantindo resultado idêntico.
  function sefazRowsFromMatrix(rawMatrix) {
    const matrix = (rawMatrix || []).filter(
      (row) => Array.isArray(row) && row.some((cell) => String(cell).trim() !== '')
    )
    if (matrix.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const headerRow = matrix[0]
    const dataRows = matrix.slice(1)
    if (dataRows.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const colIndex = {}
    for (const field of SEFAZ_REQUIRED_FIELDS) {
      const idx = findColumnIndex(headerRow, field.names)
      if (idx === -1) throw new ConciliacaoImportError(msgColunaAusente(field.label))
      colIndex[field.key] = idx
    }

    // Fornecedor = 1ª "RAZAO SOCIAL", de preferência logo após "IE EMISSOR"
    const ieEmissorIdx = findColumnIndex(headerRow, ['IE EMISSOR'])
    let fornecedorIdx = -1
    if (ieEmissorIdx !== -1 && normalizeHeader(headerRow[ieEmissorIdx + 1]) === 'RAZAO SOCIAL') {
      fornecedorIdx = ieEmissorIdx + 1
    } else {
      fornecedorIdx = findColumnIndex(headerRow, ['RAZAO SOCIAL', 'FORNECEDOR', 'NOME EMISSOR'])
    }
    if (fornecedorIdx === -1) throw new ConciliacaoImportError(msgColunaAusente('Fornecedor'))

    const chaveIdx = findColumnIndex(headerRow, ['CHAVE', 'CHAVE DE ACESSO'])
    // Só existe quando o arquivo veio de um .zip de XML (ver parseSefazZip) — o CSV
    // baixado do portal da SEFAZ nunca tem essa coluna, então `xml` fica vazio em
    // todas as linhas nesse caminho (sem tratamento especial). Habilita o botão de
    // DANFE pra TODAS as notas (não só as que casam com o sistema via conector-erp).
    const xmlIdx = findColumnIndex(headerRow, ['XML', 'XML NFE'])

    const rows = dataRows.map((cells) => {
      const get = (idx) => (idx == null || idx === -1 ? '' : cells[idx])
      const cnpjEmissorDigits = Engine.normalizeCNPJ(get(colIndex.cnpjEmissor))
      const cnpjDestinatarioDigits = Engine.normalizeCNPJ(get(colIndex.cnpjDestinatario))
      return {
        uf: Engine.stripQuotes(get(colIndex.uf)).toUpperCase(),
        chave: Engine.stripQuotes(get(chaveIdx)),
        nf: Engine.stripQuotes(get(colIndex.nf)),
        serie: Engine.stripQuotes(get(colIndex.serie)),
        emissaoRaw: Engine.stripQuotes(get(colIndex.emissao)),
        emissao: Engine.parseDateBR(get(colIndex.emissao)),
        cnpjEmissor: cnpjEmissorDigits,
        cnpjEmissorFormatado: Engine.formatCNPJ(cnpjEmissorDigits),
        fornecedor: Engine.stripQuotes(get(fornecedorIdx)),
        cnpjDestinatario: cnpjDestinatarioDigits,
        cfop: parseInt(Engine.stripQuotes(get(colIndex.cfop)), 10) || 0,
        situacao: Engine.stripQuotes(get(colIndex.situacao)).toUpperCase(),
        tipo: Engine.stripQuotes(get(colIndex.tipo)).toUpperCase(),
        valor: Engine.normalizeValor(get(colIndex.valor)),
        rejeitada: Engine.stripQuotes(get(colIndex.rejeitada)).toUpperCase(),
        xml: String(get(xmlIdx) || ''),
      }
    })

    return { rows, rawMatrix: matrix, colIndex }
  }

  // -----------------------------------------------------------------------
  // SEFAZ (.zip de XML) — alternativa ao CSV: um .zip com os XMLs das notas
  // (modelo NF-e nacional, http://www.portalfiscal.inf.br/nfe), como o baixado
  // no "Download de XMLs" do portal da SEFAZ. Cada XML vira uma linha equivalente
  // à do CSV, e o texto do XML é guardado pra habilitar o botão de DANFE em TODAS
  // as notas (não só nas que casam com o sistema via conector-erp).
  // -----------------------------------------------------------------------

  const SEFAZ_ZIP_HEADER = [
    'UF', 'CHAVE', 'NUMERO', 'SERIE', 'EMISSAO', 'CNPJ EMISSOR',
    'RAZAO SOCIAL', 'CNPJ-CPF DESTINATARIO', 'CFOP', 'SITUACAO', 'TIPO', 'VALOR', 'REJEITADA', 'XML',
  ]

  function xmlTxt(parent, tag) {
    if (!parent) return ''
    const els = parent.getElementsByTagName(tag)
    return els.length ? String(els[0].textContent || '').trim() : ''
  }

  function xmlFirstEl(parent, tag) {
    if (!parent) return null
    const els = parent.getElementsByTagName(tag)
    return els.length ? els[0] : null
  }

  // Remove os blocos <Signature> (assinatura + certificado) — não são usados pra
  // montar a DANFE e representam boa parte do tamanho do XML.
  function stripSignatures(xmlText) {
    return String(xmlText || '')
      .replace(/<(\w+:)?Signature[\s\S]*?<\/(\w+:)?Signature>/g, '')
      .trim()
  }

  function isXmlName(name) {
    return /\.xml$/i.test(name || '')
  }

  // pasta "Canceladas"/"Cancelados" em qualquer nível do .zip.
  function isCanceladaPath(path) {
    return /(^|[\\/])cancel\w*[\\/]/i.test(String(path || ''))
  }

  function zipBaseName(path) {
    return String(path || '').split(/[\\/]/).pop()
  }

  // Constrói a linha "crua" (strings, como no CSV) a partir do texto de um XML de
  // NF-e. Devolve null se o XML não for uma NF-e válida (ex.: evento de
  // cancelamento em arquivo separado, ou lixo dentro do zip) — nesse caso a linha
  // é só ignorada, sem interromper a importação do resto do lote.
  function sefazRowRawFromXml(xmlText, meta) {
    const info = meta || {}
    let doc
    try {
      doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    } catch (e) {
      return null
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null

    const infNFe = xmlFirstEl(doc, 'infNFe')
    if (!infNFe) return null

    const ide = xmlFirstEl(infNFe, 'ide')
    const emit = xmlFirstEl(infNFe, 'emit')
    const dest = xmlFirstEl(infNFe, 'dest')
    const det = xmlFirstEl(infNFe, 'det')
    const prod = xmlFirstEl(det, 'prod')
    const total = xmlFirstEl(infNFe, 'total')
    const icmsTot = xmlFirstEl(total, 'ICMSTot')

    const chave = String(infNFe.getAttribute('Id') || '').replace(/\D/g, '')
    const nf = xmlTxt(ide, 'nNF')
    if (!chave && !nf) return null

    const emitCnpj = xmlTxt(emit, 'CNPJ')
    const destCnpjCpf = xmlTxt(dest, 'CNPJ') || xmlTxt(dest, 'CPF')
    // TIPO vem do campo oficial da NF-e (ide/tpNF: 0=Entrada, 1=Saída) — é uma
    // propriedade da própria nota (fiscal/CFOP), não depende de quem somos nós.
    // Ex.: uma compra em que somos o destinatário ainda pode estar marcada como
    // "Saída" do ponto de vista fiscal da operação (confirmado 1:1 contra o CSV
    // real da SEFAZ em arquivos_exemplo/: 232/232 notas bateram). O critério
    // anterior (SAÍDA quando o emitente é um dos nossos CNPJs) estava errado —
    // não é isso que tpNF representa.
    const tipo = xmlTxt(ide, 'tpNF') === '0' ? 'ENTRADA' : 'SAÍDA'
    const dhEmi = xmlTxt(ide, 'dhEmi') || xmlTxt(ide, 'dEmi')
    const emissaoISO = (String(dhEmi).match(/^\d{4}-\d{2}-\d{2}/) || [''])[0]

    return [
      xmlTxt(emit, 'UF'), // UF
      chave, // CHAVE
      nf, // NUMERO
      xmlTxt(ide, 'serie'), // SERIE
      emissaoISO, // EMISSAO
      emitCnpj, // CNPJ EMISSOR
      xmlTxt(emit, 'xNome'), // RAZAO SOCIAL
      destCnpjCpf, // CNPJ-CPF DESTINATARIO
      xmlTxt(prod, 'CFOP'), // CFOP
      info.cancelada ? 'CANCELADA' : '', // SITUACAO
      tipo, // TIPO
      xmlTxt(icmsTot, 'vNF'), // VALOR
      'N', // REJEITADA — só existe XML autorizado; rejeitada não gera XML válido
      stripSignatures(xmlText), // XML
    ]
  }

  // Detecta um XML de EVENTO de cancelamento (procEventoNFe/retEventoNFe — tpEvento
  // 110111, cStat 135/155) e devolve a chave (44 dígitos) da nota cancelada, ou null
  // se o XML não for um evento de cancelamento. O "Download de XMLs" do portal só
  // inclui esse arquivo quando o usuário marca a opção de baixar eventos junto — por
  // isso este é um sinal best-effort: quando o zip não tem esses arquivos (caso mais
  // comum), SITUACAO cai no fallback de "AUTORIZADA" e só o CSV mesmo sabe dizer que
  // a nota foi cancelada depois (ver `attachXmlFromZip`, pensado pra esse caso).
  function chaveCanceladaFromEventoXml(xmlText) {
    let doc
    try {
      doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    } catch (e) {
      return null
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    if (xmlTxt(doc, 'tpEvento') !== '110111') return null
    const cStat = xmlTxt(doc, 'cStat')
    if (cStat !== '135' && cStat !== '155') return null
    const chave = String(xmlTxt(doc, 'chNFe')).replace(/\D/g, '')
    return chave.length === 44 ? chave : null
  }

  async function loadZipEntries(file) {
    let buffer
    try {
      buffer = await readFileAsArrayBuffer(file)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const bytes = new Uint8Array(buffer.slice(0, 4))
    if (!isZipSignature(bytes)) throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    if (!global.JSZip) throw new ConciliacaoImportError('Biblioteca de leitura de .zip indisponível.')

    let zip
    try {
      zip = await global.JSZip.loadAsync(buffer)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const entradas = []
    zip.forEach((path, entry) => {
      if (!entry.dir && isXmlName(path)) entradas.push({ path, entry })
    })
    if (!entradas.length) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const arquivos = []
    for (const { path, entry } of entradas) {
      arquivos.push({ path, xmlText: await entry.async('string') })
    }
    return arquivos
  }

  // Separa os arquivos de um lote entre "notas" (infNFe) e "eventos de
  // cancelamento" — devolve as notas junto com o Set de chaves canceladas
  // encontradas (via evento e/ou pasta "Canceladas/", os dois sinais possíveis).
  function splitNotasECancelamentos(arquivos) {
    const notas = []
    const canceladas = new Set()
    for (const { path, xmlText } of arquivos) {
      const chaveCancelada = chaveCanceladaFromEventoXml(xmlText)
      if (chaveCancelada) {
        canceladas.add(chaveCancelada)
        continue
      }
      if (isCanceladaPath(path)) {
        const m = xmlText.match(/Id="NFe(\d{44})"/)
        if (m) canceladas.add(m[1])
      }
      notas.push({ path, xmlText })
    }
    return { notas, canceladas }
  }

  async function parseSefazZip(file) {
    if (!file) throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    const arquivos = await loadZipEntries(file)
    const { notas, canceladas } = splitNotasECancelamentos(arquivos)

    const linhas = []
    for (const { path, xmlText } of notas) {
      const linha = sefazRowRawFromXml(xmlText, { arquivo: zipBaseName(path) })
      if (!linha) continue
      const chaveDigits = linha[1]
      if (canceladas.has(chaveDigits)) linha[9] = 'CANCELADA' // índice de SITUACAO em SEFAZ_ZIP_HEADER
      linhas.push(linha)
    }
    if (!linhas.length) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const matrix = [SEFAZ_ZIP_HEADER.slice(), ...linhas]
    const result = sefazRowsFromMatrix(matrix)
    result.fileName = file.name
    return result
  }

  // Anexa o XML de cada nota (casando pela chave de acesso) num resultado da SEFAZ
  // que já veio do CSV — usado quando o usuário importa o CSV *e* o .zip juntos.
  // Ao contrário de `parseSefazZip` (que tenta reconstruir a linha inteira a partir
  // só do XML), aqui SITUACAO/TIPO/CFOP/VALOR/etc. continuam vindo do CSV, que é a
  // fonte de verdade — o zip só contribui o texto do XML, habilitando o botão de
  // DANFE pra toda nota que casar pela chave.
  async function attachXmlFromZip(sefazResult, file) {
    const arquivos = await loadZipEntries(file)
    const xmlPorChave = new Map()
    for (const { xmlText } of arquivos) {
      const m = xmlText.match(/Id="NFe(\d{44})"/)
      if (m && !xmlPorChave.has(m[1])) xmlPorChave.set(m[1], stripSignatures(xmlText))
    }

    const rows = sefazResult.rows.map((row) => {
      const chaveDigits = Engine.chaveAcessoDigits(row.chave)
      const xml = (chaveDigits && xmlPorChave.get(chaveDigits)) || row.xml || ''
      return Object.assign({}, row, { xml })
    })

    const header = sefazResult.rawMatrix[0].slice()
    let xmlIdx = findColumnIndex(header, ['XML', 'XML NFE'])
    if (xmlIdx === -1) {
      header.push('XML')
      xmlIdx = header.length - 1
    }
    const body = sefazResult.rawMatrix.slice(1).map((cells, i) => {
      const novaLinha = cells.slice()
      while (novaLinha.length < header.length) novaLinha.push('')
      novaLinha[xmlIdx] = rows[i].xml
      return novaLinha
    })

    return Object.assign({}, sefazResult, { rows, rawMatrix: [header, ...body] })
  }

  // -----------------------------------------------------------------------
  // Sistema (XLSX/XLS)
  // -----------------------------------------------------------------------

  const SISTEMA_REQUIRED_FIELDS = [
    { key: 'nf', names: ['NF', 'NUMERO NF', 'NUMERO', 'Nº NF'], label: 'NF' },
    {
      key: 'valor',
      names: ['VLR. NOTA', 'VLR NOTA', 'VALOR DA NOTA', 'VALOR NOTA', 'VLR. DA NOTA', 'VALOR'],
      label: 'Vlr. Nota',
    },
  ]

  const SISTEMA_OPTIONAL_FIELDS = [
    { key: 'fornecedor', names: ['FORNECEDOR'] },
    { key: 'dataEmissao', names: ['DATA EMISSAO', 'DATA DE EMISSAO', 'EMISSAO'] },
    { key: 'chave', names: ['CHAVE DE ACESSO', 'CHAVE NFE', 'CHAVE_NFE', 'CHAVE'] },
    // Só vem preenchido quando o sistema foi buscado pelo conector-erp (o export
    // manual do Moura nunca tem essa coluna) — habilita o botão de DANFE na tabela.
    { key: 'xml', names: ['XML NFE', 'CONTEUDO XML', 'CONTEUDO_ARQUIVO_XML', 'XML'] },
  ]

  async function parseSistemaXlsx(file) {
    let buffer
    try {
      buffer = await readFileAsArrayBuffer(file)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const bytes = new Uint8Array(buffer.slice(0, 8))
    if (!isZipSignature(bytes) && !isOleSignature(bytes)) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    let workbook
    try {
      workbook = global.XLSX.read(buffer, { type: 'array' })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    // usa a primeira planilha com conteúdo
    let matrix = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      fixSheetRange(sheet)
      const candidate = global.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
      const filtered = candidate.filter((row) => row.some((cell) => String(cell).trim() !== ''))
      if (filtered.length > 1) {
        matrix = filtered
        break
      }
    }

    const result = sistemaRowsFromMatrix(matrix)
    result.fileName = file.name
    return result
  }

  // Reconstrói as linhas do sistema a partir da matriz bruta (linha 0 =
  // cabeçalho). Detecta automaticamente a origem (Moura ou Atak) e delega
  // para o parser específico. Compartilhado entre o parser de arquivo e a
  // importação de um arquivo de conciliação (.json).
  function sistemaRowsFromMatrix(rawMatrix) {
    const matrix = (rawMatrix || []).filter(
      (row) => Array.isArray(row) && row.some((cell) => String(cell).trim() !== '')
    )
    if (matrix.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    return detectSistemaOrigem(matrix) === 'atak'
      ? sistemaAtakRowsFromMatrix(matrix)
      : sistemaMouraRowsFromMatrix(matrix)
  }

  // Marcadores exclusivos do relatório do Atak (usado pela filial do CD).
  function detectSistemaOrigem(matrix) {
    for (const row of matrix.slice(0, 60)) {
      for (const cell of row) {
        // Só olha células "curtas" (cabeçalho/marcador) — colunas de texto livre
        // longo (ex.: o XML da NF-e, que o conector-erp inclui pra habilitar a
        // DANFE) podem conter a substring "atak.com.br" por coincidência (ex.: um
        // e-mail do próprio cliente/fornecedor Atak) sem o arquivo ser do Atak.
        if (typeof cell === 'string' && cell.length > 80) continue
        const h = normalizeHeader(cell)
        if (h === 'CHAVE FATO' || h.indexOf('TIPO MOVTO') === 0) return 'atak'
        if (typeof cell === 'string' && cell.toLowerCase().indexOf('atak.com.br') !== -1) return 'atak'
      }
    }
    const temDocumentoValorTotal = matrix.some(
      (row) =>
        row.some((c) => normalizeHeader(c) === 'DOCUMENTO') &&
        row.some((c) => normalizeHeader(c) === 'VALOR TOTAL')
    )
    return temDocumentoValorTotal ? 'atak' : 'moura'
  }

  function sistemaMouraRowsFromMatrix(matrix) {
    const headerRow = matrix[0]
    const dataRows = matrix.slice(1)
    if (dataRows.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const colIndex = {}
    for (const field of SISTEMA_REQUIRED_FIELDS) {
      const idx = findColumnIndex(headerRow, field.names)
      if (idx === -1) throw new ConciliacaoImportError(msgColunaAusente(field.label))
      colIndex[field.key] = idx
    }
    for (const field of SISTEMA_OPTIONAL_FIELDS) {
      colIndex[field.key] = findColumnIndex(headerRow, field.names)
    }

    const rows = dataRows.map((cells) => {
      const get = (idx) => (idx == null || idx === -1 ? '' : cells[idx])
      return {
        nf: Engine.stripQuotes(get(colIndex.nf)),
        valor: Engine.normalizeValor(get(colIndex.valor)),
        fornecedor: Engine.stripQuotes(get(colIndex.fornecedor)),
        dataEmissao: get(colIndex.dataEmissao),
        // Chave de Acesso da NF-e (44 dígitos) — quando o export do sistema traz essa
        // coluna, a casagem com a SEFAZ pode ser exata em vez de NF+valor (ver
        // Engine.buildIndices/encontraRecebida). Nem todo lançamento tem chave (ex.:
        // entradas de serviço) — nesses casos cai no fallback de sempre.
        chave: Engine.stripQuotes(get(colIndex.chave)),
        // XML completo da NF-e — só o conector-erp traz isso (ver comentário acima).
        // Sem stripQuotes: é o conteúdo bruto do XML, não um texto de planilha.
        xml: String(get(colIndex.xml) || ''),
      }
    })

    return { rows, rawMatrix: matrix, origem: 'moura' }
  }

  // Atak (filial do CD). O nº da NF e a série vêm da coluna "Documento", no
  // formato `filial-tipo-serie-numero` (ex.: 111-NEE-000-139439 -> série 000,
  // NF 139439). O valor é a coluna "Valor Total". Linhas de seção
  // ("Tipo Movto.:") e de total ("Total do Movimento:", "Total Geral:") são
  // ignoradas porque o último trecho de "Documento" não é numérico.
  // Devolve um rawMatrix já no layout do Moura (Entrada/NF/Fornecedor/.../
  // Vlr. Nota) para que o "Relatório Formatado" (Excel) funcione sem ajuste.
  const ATAK_MATRIX_HEADER = [
    'Entrada', 'NF', 'Fornecedor', 'Desconto', 'Vlr. Nota',
    'Valor Contas a Pagar', 'Pedido', 'Conferência', 'Data Emissão',
  ]

  function parseDocumentoAtak(valor) {
    const partes = String(valor == null ? '' : valor)
      .split('-')
      .map((p) => p.trim())
      .filter((p) => p !== '')
    if (partes.length < 3) return null
    const numero = partes[partes.length - 1]
    if (!/^\d+$/.test(numero)) return null
    return { nf: numero, serie: partes[partes.length - 2] }
  }

  function sistemaAtakRowsFromMatrix(matrix) {
    const headerIdx = matrix.findIndex(
      (row) =>
        row.some((c) => normalizeHeader(c) === 'DOCUMENTO') &&
        row.some((c) => ['VALOR TOTAL', 'VALOR LIQUIDO'].includes(normalizeHeader(c)))
    )
    if (headerIdx === -1) throw new ConciliacaoImportError(msgColunaAusente('Documento / Valor Total'))

    const headerRow = matrix[headerIdx]
    const docIdx = findColumnIndex(headerRow, ['DOCUMENTO'])
    const valorIdx = findColumnIndex(headerRow, ['VALOR TOTAL', 'VALOR LIQUIDO', 'VALOR'])
    const fornecedorIdx = findColumnIndex(headerRow, ['NOME DO CADASTRO', 'FORNECEDOR', 'NOME DO CLIENTE'])

    const rows = []
    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const cells = matrix[i]
      const doc = parseDocumentoAtak(cells[docIdx])
      if (!doc) continue
      rows.push({
        nf: doc.nf,
        serie: doc.serie,
        valor: Engine.normalizeValor(cells[valorIdx]),
        fornecedor: limparNomeCadastroAtak(fornecedorIdx === -1 ? '' : cells[fornecedorIdx]),
        dataEmissao: '',
      })
    }
    if (rows.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const rawMatrix = [ATAK_MATRIX_HEADER.slice()]
    for (const r of rows) {
      rawMatrix.push(['', Number(r.nf), r.fornecedor, '', r.valor, '', '', '', ''])
    }

    return { rows, rawMatrix, origem: 'atak' }
  }

  // "90327-ARCELOMITTAL BRASIL" -> "ARCELOMITTAL BRASIL"
  function limparNomeCadastroAtak(valor) {
    return Engine.stripQuotes(valor).replace(/^\s*\d+\s*-\s*/, '').trim()
  }

  global.ConciliacaoParsers = {
    ConciliacaoImportError,
    parseSefazCsv,
    parseSefazZip,
    attachXmlFromZip,
    parseSistemaXlsx,
    sefazRowsFromMatrix,
    sistemaRowsFromMatrix,
    detectSistemaOrigem,
    MSG_ARQUIVO_INVALIDO,
    MSG_ARQUIVO_VAZIO,
    MSG_FORMATO_INVALIDO,
  }
})(typeof window !== 'undefined' ? window : globalThis)
