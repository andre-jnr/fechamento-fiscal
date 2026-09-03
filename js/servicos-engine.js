/**
 * Motor de conciliação das Notas Fiscais de Serviço (NFS-e) emitidas contra
 * o nosso CNPJ — lógica pura, sem DOM, testável isoladamente.
 *
 * Reaproveita os utilitários de normalização de `ConciliacaoEngine`
 * (valores, CNPJ, datas). A regra aqui é mais simples que a da SEFAZ: a
 * NFS-e está LANÇADA quando casa com um lançamento de serviço do sistema
 * (nº + valor, ou valor + prestador), CANCELADA quando veio da pasta
 * "Canceladas" do lote, A LANÇAR quando é recente e NÃO LANÇADA no resto.
 */
;(function (global) {
  'use strict'

  const Base =
    global.ConciliacaoEngine ||
    (typeof require !== 'undefined' ? require('./conciliacao-engine.js') : null)

  if (!Base) throw new Error('servicos-engine: ConciliacaoEngine não carregado')

  const TOLERANCIA_VALOR = 0.02
  const PRAZO_DIAS = 2

  // Justificativa manual — quando diferente de "NÃO PRECISA" sobrescreve o
  // status calculado (mesma ideia da conciliação da SEFAZ).
  const JUSTIFICATIVA_OPCOES = [
    'NÃO PRECISA',
    'JÁ LANÇADA',
    'A LANÇAR',
    'NÃO LANÇAR',
    'CANCELADA',
  ]

  const JUSTIFICATIVA_STATUS = {
    'JÁ LANÇADA': 'LANÇADA',
    'A LANÇAR': 'A LANÇAR',
    'NÃO LANÇAR': 'DISPENSADA',
    CANCELADA: 'CANCELADA',
  }

  const STATUS_LIST = [
    'LANÇADA',
    'NÃO LANÇADA',
    'A LANÇAR',
    'CANCELADA',
    'DISPENSADA',
  ]

  // Palavras que não ajudam a distinguir uma razão social da outra.
  const STOPWORDS_NOME = new Set([
    'LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S', 'A', 'DA', 'DE', 'DO', 'DAS',
    'DOS', 'E', 'EM', 'COMERCIO', 'SERVICOS', 'SERVICO', 'CIA', 'THE',
  ])

  function normalizeNome(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, ' ') // CNPJ embutido no nome
      .replace(/^\s*\d{2,3}\.\d{3}\.\d{3}\s+/, ' ') // raiz de CNPJ (MEI): "33.019.591 FULANO"
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function tokensNome(value) {
    return normalizeNome(value)
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS_NOME.has(t))
  }

  // Dois nomes "casam" quando compartilham os dois primeiros tokens
  // significativos ou quando a interseção de tokens é relevante (>= 50%).
  function nomesCasam(a, b) {
    const ta = tokensNome(a)
    const tb = tokensNome(b)
    if (!ta.length || !tb.length) return false
    if (ta[0] === tb[0] && (ta[1] || '') === (tb[1] || '') && ta[1]) return true
    const setB = new Set(tb)
    const comuns = ta.filter((t) => setB.has(t)).length
    return comuns / Math.min(ta.length, tb.length) >= 0.5
  }

  function valoresCasam(valorSistema, row) {
    return (
      Math.abs(valorSistema - row.valorServico) <= TOLERANCIA_VALOR ||
      Math.abs(valorSistema - row.valorLiquido) <= TOLERANCIA_VALOR
    )
  }

  // ---------------------------------------------------------------------
  // Índices dos lançamentos do sistema (arquivo de entradas de serviço)
  // ---------------------------------------------------------------------

  function buildIndices(sistemaRows) {
    const porNF = new Map()
    const todas = []
    for (const s of sistemaRows || []) {
      const item = {
        nf: Base.normalizeNF(s.nf),
        valor: Base.normalizeValor(s.valor),
        fornecedor: s.fornecedor || '',
      }
      todas.push(item)
      if (!item.nf) continue
      if (!porNF.has(item.nf)) porNF.set(item.nf, [])
      porNF.get(item.nf).push(item)
    }
    return { porNF, todas }
  }

  // Devolve o lançamento do sistema que casa com a NFS-e (ou null).
  function encontraLancamento(row, indices) {
    const nf = Base.normalizeNF(row.numero)
    const candidatosNF = (nf && indices.porNF.get(nf)) || []
    for (const c of candidatosNF) {
      if (valoresCasam(c.valor, row)) return c
    }
    for (const c of indices.todas) {
      if (valoresCasam(c.valor, row) && nomesCasam(c.fornecedor, row.prestador)) return c
    }
    return null
  }

  // ---------------------------------------------------------------------
  // Regra principal
  // ---------------------------------------------------------------------

  function conciliar(row, indices, justificativaManual, referencia) {
    const justificativa = (justificativaManual || 'NÃO PRECISA').toUpperCase()
    if (justificativa !== 'NÃO PRECISA' && JUSTIFICATIVA_STATUS[justificativa]) {
      return JUSTIFICATIVA_STATUS[justificativa]
    }

    if (row.cancelada) return 'CANCELADA'
    if (encontraLancamento(row, indices)) return 'LANÇADA'
    if (row.emissao && isDentroPrazo(row.emissao, referencia)) return 'A LANÇAR'
    return 'NÃO LANÇADA'
  }

  function isDentroPrazo(emissao, referencia) {
    const hoje = Base.stripTime(referencia || new Date())
    const limite = new Date(hoje)
    limite.setDate(limite.getDate() - PRAZO_DIAS)
    return emissao.getTime() >= limite.getTime()
  }

  // ---------------------------------------------------------------------
  // Filtros / estatísticas
  // ---------------------------------------------------------------------

  function matchesMulti(selected, value) {
    if (!selected || !selected.length) return true
    return selected.map(String).includes(String(value))
  }

  function applyFilters(rows, filters) {
    if (!filters) return rows
    const busca = (filters.busca || '').trim().toLowerCase()
    return rows.filter((row) => {
      if (!matchesMulti(filters.status, row.status)) return false
      if (!matchesMulti(filters.prestador, row.prestador)) return false
      if (!matchesMulti(filters.cnpj, row.prestadorCnpjFormatado)) return false
      if (!matchesMulti(filters.municipio, row.municipio)) return false
      if (!matchesMulti(filters.codServico, row.codServico)) return false
      if (!matchesMulti(filters.justificativa, row.justificativa)) return false
      if (filters.iss === 'com' && !row.temIss) return false
      if (filters.iss === 'retido' && !(row.temIss && row.issRetido)) return false
      if (filters.iss === 'nao-retido' && !(row.temIss && !row.issRetido)) return false
      if (filters.iss === 'sem' && row.temIss) return false
      if (filters.dataInicio && row.emissao && row.emissao < filters.dataInicio) return false
      if (filters.dataFim && row.emissao && row.emissao > filters.dataFim) return false
      if (busca) {
        const alvo = `${row.numero} ${row.prestador} ${row.prestadorCnpjFormatado} ${row.descricao}`.toLowerCase()
        if (!alvo.includes(busca)) return false
      }
      return true
    })
  }

  function computeStats(rows) {
    const total = rows.length
    const porStatus = {}
    for (const s of STATUS_LIST) porStatus[s] = { qtd: 0, valor: 0 }

    let valorTotal = 0
    let comIss = 0
    let issRetido = 0
    let valorIss = 0
    for (const row of rows) {
      valorTotal += row.valorServico
      if (!porStatus[row.status]) porStatus[row.status] = { qtd: 0, valor: 0 }
      porStatus[row.status].qtd += 1
      porStatus[row.status].valor += row.valorServico
      if (row.temIss) {
        comIss += 1
        valorIss += row.iss
        if (row.issRetido) issRetido += 1
      }
    }

    const pct = (qtd) => (total > 0 ? (qtd / total) * 100 : 0)
    const stats = {}
    for (const [status, info] of Object.entries(porStatus)) {
      stats[status] = { qtd: info.qtd, valor: Base.round2(info.valor), pct: pct(info.qtd) }
    }

    return {
      total,
      valorTotal: Base.round2(valorTotal),
      valorNaoLancado: Base.round2(porStatus['NÃO LANÇADA'] ? porStatus['NÃO LANÇADA'].valor : 0),
      valorLancado: Base.round2(porStatus['LANÇADA'] ? porStatus['LANÇADA'].valor : 0),
      comIss,
      issRetido,
      valorIss: Base.round2(valorIss),
      porStatus: stats,
    }
  }

  // ---------------------------------------------------------------------
  // Identidade da nota (persistência do que o usuário alimenta)
  // ---------------------------------------------------------------------

  function overrideId(row) {
    const chave = String((row && row.chave) || '').replace(/\D/g, '')
    if (chave.length === 50) return chave
    return [
      row.prestadorCnpj,
      Base.normalizeNF(row.numero),
      Base.stripQuotes(row.serie),
      Base.valorKey(row.valorServico),
      row.emissao ? row.emissao.getTime() : '',
    ].join('|')
  }

  function detectMesAno(rows) {
    const counts = new Map()
    for (const row of rows) {
      if (!row.emissao) continue
      const key = `${row.emissao.getFullYear()}-${row.emissao.getMonth()}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const MESES = [
      'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
      'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
    ]
    if (counts.size === 0) {
      const now = new Date()
      return { mes: MESES[now.getMonth()], ano: now.getFullYear() }
    }
    let bestKey = null
    let bestCount = -1
    for (const [key, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        bestKey = key
      }
    }
    const [ano, mesIdx] = bestKey.split('-').map(Number)
    return { mes: MESES[mesIdx], ano }
  }

  const ServicosEngine = {
    TOLERANCIA_VALOR,
    JUSTIFICATIVA_OPCOES,
    JUSTIFICATIVA_STATUS,
    STATUS_LIST,
    normalizeNome,
    tokensNome,
    nomesCasam,
    buildIndices,
    encontraLancamento,
    conciliar,
    isDentroPrazo,
    applyFilters,
    computeStats,
    overrideId,
    detectMesAno,
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ServicosEngine
  } else {
    global.ServicosEngine = ServicosEngine
  }
})(typeof window !== 'undefined' ? window : globalThis)
