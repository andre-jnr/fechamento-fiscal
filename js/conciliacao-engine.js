/**
 * Motor de conciliação fiscal — lógica pura (sem DOM), testável isoladamente.
 * Reproduz as regras da planilha relatorio-fiscal.xlsx (tabela RELATORIO).
 */
;(function (global) {
  'use strict'

  const UNIDADES_POR_CNPJ = {
    '19234190000300': 'UNIDADE: PONTA NEGRA',
    '19234190000130': 'UNIDADE: PARQUE DEZ',
    '19234190000725': 'UNIDADE: MORADA DO SOL',
    '19234190000482': 'UNIDADE: MONTE DAS OLIVEIRAS',
  }

  const MESES_PT = [
    'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
    'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
  ]

  const JUSTIFICATIVA_OPCOES = [
    'NÃO PRECISA',
    'FALTA CHEGAR',
    'PARA REJEITAR',
    'REJEITADA',
    'RECEBIDA',
    'NÃO LANÇADA',
  ]

  const TOLERANCIA_VALOR = 0.02

  // ---------------------------------------------------------------------
  // Normalização
  // ---------------------------------------------------------------------

  function stripQuotes(value) {
    if (value == null) return ''
    return String(value).trim().replace(/^['"]+|['"]+$/g, '')
  }

  function onlyDigits(value) {
    return stripQuotes(value).replace(/\D/g, '')
  }

  function normalizeCNPJ(value) {
    return onlyDigits(value).padStart(14, '0').slice(-14)
  }

  function formatCNPJ(digits) {
    const d = onlyDigits(digits).padStart(14, '0').slice(-14)
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`
  }

  function normalizeNF(value) {
    const digits = onlyDigits(value)
    const stripped = digits.replace(/^0+/, '')
    return stripped === '' ? (digits === '' ? '' : '0') : stripped
  }

  function normalizeValor(value) {
    if (value == null || value === '') return 0
    if (typeof value === 'number') return round2(value)
    let s = String(value).trim()
    s = s.replace(/R\$\s?/gi, '').trim()
    if (s === '') return 0
    // pt-BR: milhar com ponto, decimal com vírgula
    const hasComma = s.includes(',')
    const hasDot = s.includes('.')
    if (hasComma && hasDot) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else if (hasComma) {
      s = s.replace(',', '.')
    }
    const n = parseFloat(s)
    return isNaN(n) ? 0 : round2(n)
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100
  }

  function valorKey(n) {
    return Math.round(round2(n) * 100)
  }

  function parseDateBR(value) {
    if (value == null || value === '') return null
    if (value instanceof Date) return isNaN(value) ? null : stripTime(value)
    const s = String(value).trim()
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (m) {
      const [, dd, mm, yyyy] = m
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd))
      return isNaN(d) ? null : d
    }
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
    if (iso) {
      const [, yyyy, mm, dd] = iso
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd))
      return isNaN(d) ? null : d
    }
    const d = new Date(s)
    return isNaN(d) ? null : stripTime(d)
  }

  function stripTime(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }

  function formatDateBR(d) {
    if (!d) return ''
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${d.getFullYear()}`
  }

  // ---------------------------------------------------------------------
  // Detecção de unidade e mês/ano
  // ---------------------------------------------------------------------

  function detectUnidade(rows) {
    const cnpjs = new Set()
    for (const row of rows) {
      if (row.cnpjDestinatario) cnpjs.add(row.cnpjDestinatario)
    }
    if (cnpjs.size === 0) return { label: '', cnpjs: [], multipla: false }
    if (cnpjs.size > 1) {
      return { label: 'MÚLTIPLAS UNIDADES', cnpjs: Array.from(cnpjs), multipla: true }
    }
    const cnpj = Array.from(cnpjs)[0]
    const label = UNIDADES_POR_CNPJ[cnpj] || `UNIDADE: DESCONHECIDA (${formatCNPJ(cnpj)})`
    return { label, cnpjs: [cnpj], multipla: false }
  }

  function unidadeNome(cnpj) {
    return UNIDADES_POR_CNPJ[normalizeCNPJ(cnpj)] || 'UNIDADE: DESCONHECIDA'
  }

  function detectMesAno(rows) {
    const counts = new Map()
    for (const row of rows) {
      if (!row.emissao) continue
      const key = `${row.emissao.getFullYear()}-${row.emissao.getMonth()}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    if (counts.size === 0) {
      const now = new Date()
      return { mes: MESES_PT[now.getMonth()], ano: now.getFullYear(), fallback: true }
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
    return { mes: MESES_PT[mesIdx], ano, fallback: false }
  }

  function tituloRelatorio(rows) {
    const { mes, ano } = detectMesAno(rows)
    return `RELATÓRIO FISCAL | ${mes} ${ano}`
  }

  // ---------------------------------------------------------------------
  // Índices para performance (seção 31)
  // ---------------------------------------------------------------------

  function buildIndices(sefazRows, sistemaRows) {
    // tabela_compras: por NF -> lista de {valor}
    const comprasPorNF = new Map()
    for (const c of sistemaRows) {
      const nf = normalizeNF(c.nf)
      if (!nf) continue
      if (!comprasPorNF.has(nf)) comprasPorNF.set(nf, [])
      comprasPorNF.get(nf).push(c.valor)
    }

    // Subconjuntos derivados do próprio SEFAZ (fiel à planilha real:
    // TABELA_ENTRADAS/TABELA_SAIDAS = FILTER(RELATORIO, TIPO=...))
    const entradasSefaz = sefazRows.filter((r) => r.tipo === 'ENTRADA')
    const saidasSefaz = sefazRows.filter((r) => r.tipo === 'SAÍDA')

    const saidasValores = new Set(saidasSefaz.map((r) => valorKey(r.valor)))
    const entradasValores = new Set(entradasSefaz.map((r) => valorKey(r.valor)))

    // Classificação de RELAÇÃO por NF (VLOOKUP pega a 1ª ocorrência)
    const relacaoPorNF = new Map()
    for (const r of entradasSefaz) {
      const nf = normalizeNF(r.nf)
      if (relacaoPorNF.has(nf)) continue
      relacaoPorNF.set(nf, classificarEntrada(r, saidasValores))
    }

    return { comprasPorNF, saidasValores, entradasValores, relacaoPorNF }
  }

  function classificarEntrada(row, saidasValores) {
    if (saidasValores.has(valorKey(row.valor))) return 'DEVOLUÇÃO'
    if (row.situacao === 'CANCELADA') return 'CANCELADA'
    if (row.cfop === 1926) return 'DESAGREGAÇÃO'
    return 'DEVOLUÇÃO PARCIAL OU DEVOLUÇÃO DO MÊS ANTERIOR'
  }

  function encontraRecebida(row, indices) {
    const candidatos = indices.comprasPorNF.get(normalizeNF(row.nf))
    if (!candidatos) return false
    return candidatos.some((valor) => Math.abs(valor - row.valor) <= TOLERANCIA_VALOR)
  }

  // ---------------------------------------------------------------------
  // Regra principal — ordem exata da seção 20 / fórmula real
  // ---------------------------------------------------------------------

  function conciliarNota(row, indices, justificativaManual) {
    if (!row.nf) return ''

    // 2) TIPO = ENTRADA -> branch fechado, não cai nas regras seguintes
    if (row.tipo === 'ENTRADA') {
      const nf = normalizeNF(row.nf)
      return indices.relacaoPorNF.get(nf) || classificarEntrada(row, indices.saidasValores)
    }

    // 3) NF + Valor casa no sistema (tolerância 0,02)
    if (encontraRecebida(row, indices)) return 'RECEBIDA'

    // 4) Situação cancelada
    if (row.situacao === 'CANCELADA') return 'CANCELADA'

    // 5) Indicador SEFAZ de rejeição
    if (row.rejeitada === 'S') return 'REJEITADA'

    // 6) Justificativa manual sobrescreve
    const justificativa = (justificativaManual || 'NÃO PRECISA').toUpperCase()
    if (justificativa !== 'NÃO PRECISA') return justificativa

    // 7) CFOP 5926 -> Desagregação
    if (row.cfop === 5926) return 'DESAGREGAÇÃO'

    // 8) Valor casa exatamente com alguma linha ENTRADA do próprio SEFAZ
    if (indices.entradasValores.has(valorKey(row.valor))) return 'DEVOLUÇÃO'

    // 9) CFOP 5927 -> Descarte
    if (row.cfop === 5927) return 'DESCARTE'

    // 10) UF diferente de AM
    if (row.uf !== 'AM') return 'EM TRANSPORTE'

    // 11) Emissão nos últimos 2 dias
    if (row.emissao && isDentroPrazo(row.emissao)) return 'FALTA CHEGAR'

    // 12) Caso contrário
    return 'NÃO LANÇADA'
  }

  function isDentroPrazo(emissao, referencia) {
    const hoje = stripTime(referencia || new Date())
    const limite = new Date(hoje)
    limite.setDate(limite.getDate() - 2)
    return emissao.getTime() >= limite.getTime()
  }

  // ---------------------------------------------------------------------
  // Filtros e estatísticas
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
      if (!matchesMulti(filters.uf, row.uf)) return false
      if (!matchesMulti(filters.fornecedor, row.fornecedor)) return false
      if (!matchesMulti(filters.cnpj, row.cnpjEmissorFormatado)) return false
      if (!matchesMulti(filters.tipo, row.tipo)) return false
      if (!matchesMulti(filters.cfop, row.cfop)) return false
      if (!matchesMulti(filters.situacao, row.situacao)) return false
      if (!matchesMulti(filters.justificativa, row.justificativa)) return false
      if (!matchesMulti(filters.unidade, row.unidade)) return false
      if (filters.dataInicio && row.emissao && row.emissao < filters.dataInicio) return false
      if (filters.dataFim && row.emissao && row.emissao > filters.dataFim) return false
      if (busca) {
        const alvo = `${row.nf} ${row.fornecedor} ${row.cnpjEmissorFormatado}`.toLowerCase()
        if (!alvo.includes(busca)) return false
      }
      return true
    })
  }

  const STATUS_LIST = [
    'RECEBIDA', 'NÃO LANÇADA', 'FALTA CHEGAR', 'REJEITADA', 'CANCELADA',
    'EM TRANSPORTE', 'DESAGREGAÇÃO', 'DEVOLUÇÃO', 'DESCARTE',
    'PARA REJEITAR', 'DEVOLUÇÃO PARCIAL OU DEVOLUÇÃO DO MÊS ANTERIOR',
  ]

  function computeStats(rows) {
    const total = rows.length
    const porStatus = {}
    for (const s of STATUS_LIST) porStatus[s] = { qtd: 0, valor: 0 }

    let valorTotal = 0
    for (const row of rows) {
      valorTotal += row.valor
      if (!porStatus[row.status]) porStatus[row.status] = { qtd: 0, valor: 0 }
      porStatus[row.status].qtd += 1
      porStatus[row.status].valor += row.valor
    }

    const pct = (qtd) => (total > 0 ? (qtd / total) * 100 : 0)
    const stats = {}
    for (const [status, info] of Object.entries(porStatus)) {
      stats[status] = { qtd: info.qtd, valor: round2(info.valor), pct: pct(info.qtd) }
    }

    return {
      total,
      valorTotal: round2(valorTotal),
      valorNaoLancado: round2(porStatus['NÃO LANÇADA'] ? porStatus['NÃO LANÇADA'].valor : 0),
      valorRecebido: round2(porStatus['RECEBIDA'] ? porStatus['RECEBIDA'].valor : 0),
      porStatus: stats,
    }
  }

  // ---------------------------------------------------------------------
  // Chave de identidade da nota (dedupe / persistência)
  // ---------------------------------------------------------------------

  function noteKey(row) {
    return [
      row.cnpjEmissor,
      normalizeNF(row.nf),
      stripQuotes(row.serie),
      valorKey(row.valor),
      row.emissao ? row.emissao.getTime() : '',
    ].join('|')
  }

  const ConciliacaoEngine = {
    UNIDADES_POR_CNPJ,
    JUSTIFICATIVA_OPCOES,
    TOLERANCIA_VALOR,
    normalizeCNPJ,
    formatCNPJ,
    normalizeNF,
    normalizeValor,
    round2,
    valorKey,
    parseDateBR,
    formatDateBR,
    stripTime,
    detectUnidade,
    unidadeNome,
    detectMesAno,
    tituloRelatorio,
    buildIndices,
    classificarEntrada,
    conciliarNota,
    isDentroPrazo,
    applyFilters,
    computeStats,
    noteKey,
    stripQuotes,
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ConciliacaoEngine
  } else {
    global.ConciliacaoEngine = ConciliacaoEngine
  }
})(typeof window !== 'undefined' ? window : globalThis)
