/**
 * Orquestração da página de Conciliação Fiscal: upload, execução da
 * conciliação, dashboard, filtros, tabela (ordenação/paginação/edição
 * inline) e exportação. Depende de ConciliacaoEngine, ConciliacaoParsers e
 * ConciliacaoStorage (carregados antes deste script).
 */
;(function () {
  'use strict'

  const Engine = window.ConciliacaoEngine
  const Parsers = window.ConciliacaoParsers
  const Storage = window.ConciliacaoStorage

  const JUSTIFICATIVA_LABELS = {
    'NÃO PRECISA': 'Não precisa',
    'FALTA CHEGAR': 'Falta chegar',
    'PARA REJEITAR': 'Para rejeitar',
    REJEITADA: 'Rejeitada',
    RECEBIDA: 'Recebida',
    'NÃO LANÇADA': 'Não lançada',
  }

  const STAT_CARDS = [
    { key: '__total__', label: 'Total de Notas' },
    { key: 'RECEBIDA', label: 'Recebidas' },
    { key: 'NÃO LANÇADA', label: 'Não Lançadas' },
    { key: 'FALTA CHEGAR', label: 'Falta Chegar' },
    { key: 'REJEITADA', label: 'Rejeitadas' },
    { key: 'CANCELADA', label: 'Canceladas' },
    { key: 'EM TRANSPORTE', label: 'Em Transporte' },
    { key: 'DESAGREGAÇÃO', label: 'Desagregação' },
    { key: 'DEVOLUÇÃO', label: 'Devolução' },
    { key: 'DESCARTE', label: 'Descarte' },
  ]

  const currencyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

  const state = {
    sefaz: null,
    sistema: null,
    indices: null,
    reconciled: [],
    reconciledByKey: new Map(),
    filters: {},
    sort: { key: 'emissao', dir: 'desc' },
    page: 1,
    pageSize: 100,
  }

  const el = (id) => document.getElementById(id)

  // -----------------------------------------------------------------------
  // Multi-select (filtros)
  // -----------------------------------------------------------------------

  const multiSelects = new Map()

  function normalizeSearch(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
  }

  function createMultiSelect(id, placeholder) {
    const root = el(id)
    root.innerHTML = `
      <button type="button" class="conc-multiselect-toggle">
        <span class="conc-multiselect-label"></span>
        <span class="conc-multiselect-caret">▾</span>
      </button>
      <div class="conc-multiselect-menu">
        <div class="conc-multiselect-search-wrap">
          <input type="text" class="conc-multiselect-search" placeholder="Pesquisar..." />
        </div>
        <div class="conc-multiselect-options"></div>
      </div>
    `
    const toggle = root.querySelector('.conc-multiselect-toggle')
    const label = root.querySelector('.conc-multiselect-label')
    const searchInput = root.querySelector('.conc-multiselect-search')
    const optionsList = root.querySelector('.conc-multiselect-options')
    let options = []
    let selected = new Set()

    function updateToggle() {
      if (selected.size === 0) label.textContent = placeholder
      else if (selected.size === 1) {
        const opt = options.find((o) => o.value === Array.from(selected)[0])
        label.textContent = opt ? opt.label : placeholder
      } else label.textContent = `${placeholder} (${selected.size})`
      toggle.classList.toggle('is-active', selected.size > 0)
    }

    function appendEmpty(text) {
      const empty = document.createElement('div')
      empty.className = 'conc-multiselect-menu-empty'
      empty.textContent = text
      optionsList.appendChild(empty)
    }

    function renderOptions() {
      optionsList.innerHTML = ''
      if (!options.length) return appendEmpty('Nenhuma opção')
      const query = normalizeSearch(searchInput.value)
      const filtered = query ? options.filter((o) => normalizeSearch(o.label).includes(query)) : options
      if (!filtered.length) return appendEmpty('Nenhum resultado')
      for (const opt of filtered) {
        const optLabel = document.createElement('label')
        optLabel.className = 'conc-multiselect-option'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = opt.value
        cb.checked = selected.has(opt.value)
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(opt.value)
          else selected.delete(opt.value)
          updateToggle()
          root.dispatchEvent(new Event('change'))
        })
        optLabel.appendChild(cb)
        optLabel.appendChild(document.createTextNode(opt.label))
        optionsList.appendChild(optLabel)
      }
    }

    searchInput.addEventListener('input', renderOptions)
    searchInput.addEventListener('click', (e) => e.stopPropagation())

    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = !root.classList.contains('is-open')
      closeAllMultiSelects()
      if (willOpen) {
        root.classList.add('is-open')
        searchInput.value = ''
        renderOptions()
        requestAnimationFrame(() => searchInput.focus())
      }
    })

    const api = {
      setOptions(values, labelFn) {
        options = values.map((v) => ({ value: String(v), label: labelFn ? labelFn(v) : String(v) }))
        selected = new Set(Array.from(selected).filter((v) => options.some((o) => o.value === v)))
        renderOptions()
        updateToggle()
      },
      getValues() {
        return Array.from(selected)
      },
      setValues(values) {
        selected = new Set((values || []).map(String))
        renderOptions()
        updateToggle()
      },
      clear() {
        selected = new Set()
        renderOptions()
        updateToggle()
      },
    }
    updateToggle()
    multiSelects.set(id, api)
    return api
  }

  function closeAllMultiSelects() {
    document.querySelectorAll('.conc-multiselect.is-open').forEach((r) => r.classList.remove('is-open'))
  }

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.conc-multiselect.is-open').forEach((r) => {
      if (!r.contains(e.target)) r.classList.remove('is-open')
    })
  })

  // -----------------------------------------------------------------------
  // Toasts
  // -----------------------------------------------------------------------

  function showToast(message, type) {
    const container = el('toasts')
    const toast = document.createElement('div')
    toast.className = 'conc-toast' + (type ? ` conc-toast--${type}` : '')
    toast.textContent = message
    container.appendChild(toast)
    setTimeout(() => toast.remove(), 5000)
  }

  // -----------------------------------------------------------------------
  // Upload
  // -----------------------------------------------------------------------

  function setupUpload(cardId, dropId, inputId, statusId, onFile) {
    const card = el(cardId)
    const drop = el(dropId)
    const input = el(inputId)
    const status = el(statusId)

    input.addEventListener('change', () => {
      if (input.files && input.files[0]) handle(input.files[0])
    })

    ;['dragover', 'dragenter'].forEach((evt) =>
      drop.addEventListener(evt, (e) => {
        e.preventDefault()
        card.classList.add('is-dragover')
      })
    )
    ;['dragleave', 'dragend'].forEach((evt) =>
      drop.addEventListener(evt, () => card.classList.remove('is-dragover'))
    )
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      card.classList.remove('is-dragover')
      const file = e.dataTransfer.files && e.dataTransfer.files[0]
      if (file) handle(file)
    })

    async function handle(file) {
      status.innerHTML = ''
      card.classList.remove('is-loaded')
      try {
        const result = await onFile(file)
        card.classList.add('is-loaded')
        status.innerHTML = `<span class="dot"></span> ${escapeHtml(file.name)} — ${result.rows.length} notas`
        updateConciliarButton()
      } catch (err) {
        card.classList.remove('is-loaded')
        const msg = err instanceof Parsers.ConciliacaoImportError ? err.message : Parsers.MSG_FORMATO_INVALIDO
        showToast(msg, 'error')
        status.innerHTML = ''
      }
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div')
    div.textContent = s == null ? '' : String(s)
    return div.innerHTML
  }

  function updateConciliarButton() {
    el('btnConciliar').disabled = !(state.sefaz && state.sistema)
  }

  // -----------------------------------------------------------------------
  // Conciliação
  // -----------------------------------------------------------------------

  async function runConciliacao() {
    const btn = el('btnConciliar')
    btn.disabled = true
    el('progressWrap').classList.add('is-active')
    updateProgress(0)
    await nextTick()

    try {
      const sefazRows = state.sefaz.rows
      const sistemaRows = state.sistema.rows
      const indices = Engine.buildIndices(sefazRows, sistemaRows)
      const overrides = await Storage.getAllOverrides()

      const results = []
      const chunkSize = 500
      for (let i = 0; i < sefazRows.length; i += chunkSize) {
        const chunk = sefazRows.slice(i, i + chunkSize)
        for (const row of chunk) {
          const key = Engine.noteKey(row)
          const override = overrides.get(key)
          const justificativa = (override && override.justificativa) || 'NÃO PRECISA'
          const observacao = (override && override.observacao) || ''
          const unidade = Engine.unidadeNome(row.cnpjDestinatario)
          const status = Engine.conciliarNota(row, indices, justificativa)
          results.push(Object.assign({}, row, { key, unidade, justificativa, observacao, status }))
        }
        updateProgress(Math.round(((i + chunk.length) / sefazRows.length) * 100))
        await nextTick()
      }

      state.indices = indices
      state.reconciled = results
      state.reconciledByKey = new Map(results.map((r) => [r.key, r]))
      state.page = 1

      renderHeader()
      renderFilterOptions()
      renderStats()
      renderTable()

      const stats = Engine.computeStats(results)
      await Storage.addHistoryEntry({
        sefazFileName: state.sefaz.fileName,
        sistemaFileName: state.sistema.fileName,
        totalNotas: stats.total,
        recebidas: stats.porStatus.RECEBIDA ? stats.porStatus.RECEBIDA.qtd : 0,
        naoLancadas: stats.porStatus['NÃO LANÇADA'] ? stats.porStatus['NÃO LANÇADA'].qtd : 0,
        rejeitadas: stats.porStatus.REJEITADA ? stats.porStatus.REJEITADA.qtd : 0,
        responsavel: el('inputResponsavel').value || '',
      })

      el('btnExportAll').disabled = false
      el('btnExportFiltered').disabled = false
      el('btnRelatorioFormatado').disabled = false
      el('emptyState').style.display = 'none'
      showToast(`Conciliação concluída — ${results.length} notas processadas`, 'success')
    } catch (err) {
      console.error(err)
      showToast('Não foi possível concluir a conciliação. Verifique os arquivos importados.', 'error')
    } finally {
      el('progressWrap').classList.remove('is-active')
      btn.disabled = false
    }
  }

  function updateProgress(pct) {
    el('progressBar').style.width = pct + '%'
    el('progressLabel').textContent = `Processando notas... ${pct}%`
  }

  function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  // -----------------------------------------------------------------------
  // Header (título / unidade)
  // -----------------------------------------------------------------------

  function renderHeader() {
    const rows = state.sefaz ? state.sefaz.rows : []
    el('reportTitle').textContent = Engine.tituloRelatorio(rows)
    const unidade = Engine.detectUnidade(rows)
    el('reportUnidade').textContent = unidade.label
    el('filterUnidade').style.display = unidade.multipla ? '' : 'none'
  }

  // -----------------------------------------------------------------------
  // Filtros
  // -----------------------------------------------------------------------

  function uniqueSorted(rows, key) {
    return Array.from(new Set(rows.map((r) => r[key]).filter((v) => v !== '' && v != null))).sort((a, b) =>
      String(a).localeCompare(String(b), 'pt-BR')
    )
  }

  function renderFilterOptions() {
    const rows = state.reconciled
    multiSelects.get('filterStatus').setOptions(uniqueSorted(rows, 'status').filter(Boolean))
    multiSelects.get('filterUf').setOptions(uniqueSorted(rows, 'uf'))
    multiSelects.get('filterFornecedor').setOptions(uniqueSorted(rows, 'fornecedor'))
    multiSelects.get('filterCnpj').setOptions(uniqueSorted(rows, 'cnpjEmissorFormatado'))
    multiSelects.get('filterTipo').setOptions(uniqueSorted(rows, 'tipo'))
    multiSelects.get('filterCfop').setOptions(
      Array.from(new Set(rows.map((r) => r.cfop).filter(Boolean))).sort((a, b) => a - b)
    )
    multiSelects.get('filterSituacao').setOptions(uniqueSorted(rows, 'situacao'))
    multiSelects
      .get('filterJustificativa')
      .setOptions(Engine.JUSTIFICATIVA_OPCOES, (v) => JUSTIFICATIVA_LABELS[v] || v)
    multiSelects.get('filterUnidade').setOptions(uniqueSorted(rows, 'unidade'))
    el('filtersBar').style.display = 'flex'
  }

  function readFilters() {
    const f = {
      status: multiSelects.get('filterStatus').getValues(),
      uf: multiSelects.get('filterUf').getValues(),
      fornecedor: multiSelects.get('filterFornecedor').getValues(),
      cnpj: multiSelects.get('filterCnpj').getValues(),
      tipo: multiSelects.get('filterTipo').getValues(),
      cfop: multiSelects.get('filterCfop').getValues(),
      situacao: multiSelects.get('filterSituacao').getValues(),
      justificativa: multiSelects.get('filterJustificativa').getValues(),
      unidade: multiSelects.get('filterUnidade').getValues(),
      busca: el('filterBusca').value,
    }
    const dataInicio = el('filterDataInicio').value
    const dataFim = el('filterDataFim').value
    if (dataInicio) f.dataInicio = new Date(dataInicio + 'T00:00:00')
    if (dataFim) f.dataFim = new Date(dataFim + 'T00:00:00')
    return f
  }

  function getFilteredRows() {
    return Engine.applyFilters(state.reconciled, readFilters())
  }

  function clearFilters() {
    ;[
      'filterStatus', 'filterUf', 'filterFornecedor', 'filterCnpj', 'filterTipo',
      'filterCfop', 'filterSituacao', 'filterJustificativa', 'filterUnidade',
    ].forEach((id) => multiSelects.get(id).clear())
    el('filterBusca').value = ''
    el('filterDataInicio').value = ''
    el('filterDataFim').value = ''
    state.page = 1
    renderStats()
    renderTable()
  }

  // -----------------------------------------------------------------------
  // Dashboard
  // -----------------------------------------------------------------------

  function renderStats() {
    const grid = el('statsGrid')
    grid.style.display = 'grid'
    grid.innerHTML = ''
    const stats = Engine.computeStats(state.reconciled)
    const statusFilter = multiSelects.get('filterStatus')
    const activeStatuses = statusFilter.getValues()

    for (const card of STAT_CARDS) {
      const isTotal = card.key === '__total__'
      const qtd = isTotal ? stats.total : stats.porStatus[card.key] ? stats.porStatus[card.key].qtd : 0
      const pct = isTotal ? 100 : stats.porStatus[card.key] ? stats.porStatus[card.key].pct : 0

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'conc-stat-card' + (isTotal ? ' conc-stat-card--total' : '')
      if (!isTotal && activeStatuses.includes(card.key)) btn.classList.add('is-active')
      btn.innerHTML = `
        <div class="label">${escapeHtml(card.label)}</div>
        <div class="value">${qtd.toLocaleString('pt-BR')}</div>
        ${isTotal ? '' : `<div class="pct">${pct.toFixed(1)}%</div>`}
      `
      btn.addEventListener('click', () => {
        if (isTotal) {
          statusFilter.clear()
        } else {
          const current = statusFilter.getValues()
          const next = current.includes(card.key) ? current.filter((v) => v !== card.key) : current.concat(card.key)
          statusFilter.setValues(next)
        }
        state.page = 1
        renderStats()
        renderTable()
      })
      grid.appendChild(btn)
    }

    const valorSelecionado = getFilteredRows().reduce((sum, row) => sum + (row.valor || 0), 0)

    const extra = [
      { label: 'Total em Valor', value: currencyFmt.format(stats.valorTotal) },
      { label: 'Valor Selecionado', value: currencyFmt.format(valorSelecionado) },
      { label: 'Valor Não Lançado', value: currencyFmt.format(stats.valorNaoLancado) },
      { label: 'Valor Recebido', value: currencyFmt.format(stats.valorRecebido) },
    ]
    for (const item of extra) {
      const card = document.createElement('div')
      card.className = 'conc-stat-card'
      card.style.cursor = 'default'
      card.innerHTML = `<div class="label">${escapeHtml(item.label)}</div><div class="value" style="font-size:1.15rem">${escapeHtml(item.value)}</div>`
      grid.appendChild(card)
    }
  }

  // -----------------------------------------------------------------------
  // Tabela
  // -----------------------------------------------------------------------

  function statusClass(status) {
    if (!status) return 'badge--neutro'
    const slug = status
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
    return `badge--${slug}`
  }

  function sortRows(rows) {
    const { key, dir } = state.sort
    const mult = dir === 'asc' ? 1 : -1
    const numeric = new Set(['nf', 'cfop', 'valor'])
    return rows.slice().sort((a, b) => {
      let av = a[key]
      let bv = b[key]
      if (key === 'emissao') {
        av = av ? av.getTime() : 0
        bv = bv ? bv.getTime() : 0
        return (av - bv) * mult
      }
      if (numeric.has(key)) {
        av = key === 'nf' ? parseInt(Engine.normalizeNF(av), 10) || 0 : Number(av) || 0
        bv = key === 'nf' ? parseInt(Engine.normalizeNF(bv), 10) || 0 : Number(bv) || 0
        return (av - bv) * mult
      }
      return String(av || '').localeCompare(String(bv || ''), 'pt-BR') * mult
    })
  }

  function renderTable() {
    if (!state.reconciled.length) return
    const filtered = getFilteredRows()
    const sorted = sortRows(filtered)

    const totalPages = Math.max(1, Math.ceil(sorted.length / state.pageSize))
    state.page = Math.min(Math.max(1, state.page), totalPages)
    const startIdx = (state.page - 1) * state.pageSize
    const pageRows = sorted.slice(startIdx, startIdx + state.pageSize)

    const tbody = el('tableBody')
    tbody.innerHTML = ''
    const frag = document.createDocumentFragment()

    for (const row of pageRows) {
      const tr = document.createElement('tr')

      tr.appendChild(td(row.uf))
      tr.appendChild(td(row.nf))
      tr.appendChild(td(row.serie))
      tr.appendChild(td(row.emissao ? Engine.formatDateBR(row.emissao) : row.emissaoRaw))
      tr.appendChild(td(row.cnpjEmissorFormatado))
      tr.appendChild(td(row.fornecedor))
      tr.appendChild(td(row.cfop || ''))
      tr.appendChild(td(row.situacao))
      tr.appendChild(td(row.tipo))
      tr.appendChild(td(currencyFmt.format(row.valor), 'col-valor'))

      const statusTd = document.createElement('td')
      if (row.status) {
        const badge = document.createElement('span')
        badge.className = `badge ${statusClass(row.status)}`
        badge.textContent = row.status
        statusTd.appendChild(badge)
      }
      tr.appendChild(statusTd)

      const justTd = document.createElement('td')
      const select = document.createElement('select')
      select.className = 'justificativa-select'
      select.dataset.key = row.key
      for (const opt of Engine.JUSTIFICATIVA_OPCOES) {
        const optEl = document.createElement('option')
        optEl.value = opt
        optEl.textContent = JUSTIFICATIVA_LABELS[opt] || opt
        if (opt === row.justificativa) optEl.selected = true
        select.appendChild(optEl)
      }
      justTd.appendChild(select)
      tr.appendChild(justTd)

      const obsTd = document.createElement('td')
      obsTd.className = 'col-observacao'
      const input = document.createElement('input')
      input.className = 'observacao-input'
      input.type = 'text'
      input.value = row.observacao || ''
      input.dataset.key = row.key
      input.placeholder = 'Adicionar observação...'
      obsTd.appendChild(input)
      tr.appendChild(obsTd)

      frag.appendChild(tr)
    }
    tbody.appendChild(frag)

    el('tableWrap').style.display = 'block'
    el('emptyState').style.display = sorted.length ? 'none' : 'block'
    if (!sorted.length) el('emptyState').textContent = 'Nenhuma nota encontrada para os filtros aplicados.'

    const shownFrom = sorted.length ? startIdx + 1 : 0
    const shownTo = Math.min(sorted.length, startIdx + pageRows.length)
    el('paginationInfo').textContent = `Mostrando ${shownFrom.toLocaleString('pt-BR')}–${shownTo.toLocaleString('pt-BR')} de ${sorted.length.toLocaleString('pt-BR')} notas`
    el('pageIndicator').textContent = `Página ${state.page} de ${totalPages}`
    el('btnPrevPage').disabled = state.page <= 1
    el('btnNextPage').disabled = state.page >= totalPages

    document.querySelectorAll('.conc-table thead th[data-sort]').forEach((th) => {
      th.classList.toggle('is-sorted', th.dataset.sort === state.sort.key)
      const icon = th.querySelector('.sort-icon')
      if (th.dataset.sort === state.sort.key) icon.textContent = state.sort.dir === 'asc' ? '↑' : '↓'
      else icon.textContent = '↕'
    })
  }

  function td(text, className) {
    const cell = document.createElement('td')
    if (className) cell.className = className
    cell.textContent = text == null ? '' : text
    return cell
  }

  // -----------------------------------------------------------------------
  // Edição inline (delegação de eventos)
  // -----------------------------------------------------------------------

  function setupInlineEdit() {
    const tbody = el('tableBody')
    tbody.addEventListener('change', (e) => {
      if (e.target.matches('.justificativa-select')) onJustificativaChange(e.target)
      else if (e.target.matches('.observacao-input')) onObservacaoChange(e.target)
    })
  }

  function onJustificativaChange(target) {
    const row = state.reconciledByKey.get(target.dataset.key)
    if (!row) return
    row.justificativa = target.value
    row.status = Engine.conciliarNota(row, state.indices, row.justificativa)
    persistOverride(row)
    renderStats()
    renderFilterOptions()
    renderTable()
  }

  function onObservacaoChange(target) {
    const row = state.reconciledByKey.get(target.dataset.key)
    if (!row) return
    row.observacao = target.value
    persistOverride(row)
  }

  function persistOverride(row) {
    Storage.saveOverride(row.key, { justificativa: row.justificativa, observacao: row.observacao }).catch(
      (err) => console.error('Falha ao salvar edição', err)
    )
  }

  // -----------------------------------------------------------------------
  // Exportação
  // -----------------------------------------------------------------------

  function exportRows(rows, filename) {
    const data = rows.map((r) => ({
      UF: r.uf,
      NF: r.nf,
      Série: r.serie,
      Emissão: r.emissao ? Engine.formatDateBR(r.emissao) : r.emissaoRaw,
      'CNPJ Emissor': r.cnpjEmissorFormatado,
      Fornecedor: r.fornecedor,
      CFOP: r.cfop,
      Situação: r.situacao,
      Tipo: r.tipo,
      Valor: r.valor,
      Status: r.status,
      Justificativa: JUSTIFICATIVA_LABELS[r.justificativa] || r.justificativa,
      Observação: r.observacao,
    }))
    const ws = window.XLSX.utils.json_to_sheet(data)
    const wb = window.XLSX.utils.book_new()
    window.XLSX.utils.book_append_sheet(wb, ws, 'Conciliação')
    window.XLSX.writeFile(wb, filename)
  }

  // -----------------------------------------------------------------------
  // Relatório formatado (planilha original) — cola os dados brutos
  // importados nas abas SEFAZ/SISTEMA do modelo relatorio-fiscal.xlsx, que
  // já contém as fórmulas/dashboard prontos. Substitui o passo manual de
  // copiar e colar que era feito direto no Excel.
  // -----------------------------------------------------------------------

  const RELATORIO_TEMPLATE_URL = 'relatorio-fiscal.xlsx'

  async function gerarRelatorioFormatado() {
    if (!state.sefaz || !state.sistema) return
    const btn = el('btnRelatorioFormatado')
    btn.disabled = true
    try {
      const limite = window.ConciliacaoRelatorio.RELATORIO_LIMITE_LINHAS
      if (state.sefaz.rows.length > limite) {
        showToast(
          `Atenção: o modelo calcula automaticamente até ${limite.toLocaleString('pt-BR')} notas por planilha; as notas excedentes ficarão só na aba SEFAZ, sem cálculo automático.`,
          'error'
        )
      }

      const blob = await window.ConciliacaoRelatorio.gerar(
        RELATORIO_TEMPLATE_URL,
        state.sefaz,
        state.sistema,
        state.reconciled
      )

      const { mes, ano } = Engine.detectMesAno(state.sefaz.rows)
      const filename = `relatorio-fiscal-${mes.toLowerCase()}-${ano}.xlsx`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      showToast('Relatório formatado gerado com sucesso.', 'success')
    } catch (err) {
      console.error(err)
      showToast('Não foi possível gerar o relatório formatado. Tente novamente.', 'error')
    } finally {
      btn.disabled = false
    }
  }

  // -----------------------------------------------------------------------
  // Bootstrap
  // -----------------------------------------------------------------------

  function bootstrap() {
    createMultiSelect('filterStatus', 'Status')
    createMultiSelect('filterUf', 'UF')
    createMultiSelect('filterFornecedor', 'Fornecedor')
    createMultiSelect('filterCnpj', 'CNPJ')
    createMultiSelect('filterTipo', 'Tipo')
    createMultiSelect('filterCfop', 'CFOP')
    createMultiSelect('filterSituacao', 'Situação')
    createMultiSelect('filterJustificativa', 'Justificativa')
    createMultiSelect('filterUnidade', 'Unidade')

    setupUpload('cardSefaz', 'dropSefaz', 'inputSefaz', 'statusSefaz', async (file) => {
      const result = await Parsers.parseSefazCsv(file)
      state.sefaz = result
      renderHeader()
      return result
    })

    setupUpload('cardSistema', 'dropSistema', 'inputSistema', 'statusSistema', async (file) => {
      const result = await Parsers.parseSistemaXlsx(file)
      state.sistema = result
      return result
    })

    el('btnConciliar').addEventListener('click', runConciliacao)
    el('btnExportAll').addEventListener('click', () => exportRows(state.reconciled, 'conciliacao-fiscal.xlsx'))
    el('btnExportFiltered').addEventListener('click', () => exportRows(getFilteredRows(), 'conciliacao-fiscal-filtrado.xlsx'))
    el('btnRelatorioFormatado').addEventListener('click', gerarRelatorioFormatado)

    ;[
      'filterStatus', 'filterUf', 'filterFornecedor', 'filterCnpj', 'filterTipo',
      'filterCfop', 'filterSituacao', 'filterJustificativa', 'filterUnidade',
      'filterDataInicio', 'filterDataFim',
    ].forEach((id) =>
      el(id).addEventListener('change', () => {
        state.page = 1
        renderStats()
        renderTable()
      })
    )
    let buscaTimer
    el('filterBusca').addEventListener('input', () => {
      clearTimeout(buscaTimer)
      buscaTimer = setTimeout(() => {
        state.page = 1
        renderTable()
      }, 200)
    })
    el('btnClearFilters').addEventListener('click', clearFilters)

    document.querySelectorAll('.conc-table thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
        else state.sort = { key, dir: 'asc' }
        renderTable()
      })
    })

    el('pageSize').addEventListener('change', (e) => {
      state.pageSize = parseInt(e.target.value, 10)
      state.page = 1
      renderTable()
    })
    el('btnPrevPage').addEventListener('click', () => {
      state.page -= 1
      renderTable()
    })
    el('btnNextPage').addEventListener('click', () => {
      state.page += 1
      renderTable()
    })

    setupInlineEdit()

    const savedResponsavel = localStorage.getItem('conc_responsavel')
    if (savedResponsavel) el('inputResponsavel').value = savedResponsavel
    el('inputResponsavel').addEventListener('change', (e) =>
      localStorage.setItem('conc_responsavel', e.target.value)
    )
  }

  document.addEventListener('DOMContentLoaded', bootstrap)
})()
