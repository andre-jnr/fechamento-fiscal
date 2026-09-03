/**
 * Orquestração da página de Conciliação de Notas de Serviço (NFS-e):
 * upload do lote de XML + arquivo do sistema, execução da conciliação,
 * dashboard, filtros, tabela (ordenação/paginação/edição inline) e
 * exportação. Depende de ServicosEngine, ServicosParsers e ServicosStorage.
 */
;(function () {
  'use strict'

  const Base = window.ConciliacaoEngine
  const Engine = window.ServicosEngine
  const Parsers = window.ServicosParsers
  const Storage = window.ServicosStorage
  const Danfse = window.ServicosDanfse

  const JUSTIFICATIVA_LABELS = {
    'NÃO PRECISA': 'Não precisa',
    'JÁ LANÇADA': 'Já lançada',
    'A LANÇAR': 'A lançar',
    'NÃO LANÇAR': 'Não lançar',
    CANCELADA: 'Cancelada',
  }

  const STAT_CARDS = [
    { key: '__total__', label: 'Total de NFS-e' },
    { key: 'LANÇADA', label: 'Lançadas' },
    { key: 'NÃO LANÇADA', label: 'Não Lançadas' },
    { key: 'A LANÇAR', label: 'A Lançar' },
    { key: 'CANCELADA', label: 'Canceladas' },
    { key: 'DISPENSADA', label: 'Dispensadas' },
    { key: '__iss__', label: 'Com ISS' },
  ]

  const currencyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

  const state = {
    nfse: null,
    sistema: null,
    indices: null,
    reconciled: [],
    reconciledByKey: new Map(),
    sistemaSemNfse: 0,
    sort: { key: 'emissao', dir: 'desc' },
    page: 1,
    pageSize: 100,
  }

  const el = (id) => document.getElementById(id)

  // -----------------------------------------------------------------------
  // Multi-select (reaproveita o CSS .conc-multiselect)
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
      const filtered = query
        ? options.filter((o) => normalizeSearch(o.label).includes(query))
        : options
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

  function escapeHtml(s) {
    const div = document.createElement('div')
    div.textContent = s == null ? '' : String(s)
    return div.innerHTML
  }

  // -----------------------------------------------------------------------
  // Upload
  // -----------------------------------------------------------------------

  function setupUpload(cardId, dropId, inputId, statusId, onFiles) {
    const card = el(cardId)
    const drop = el(dropId)
    const input = el(inputId)
    const status = el(statusId)

    input.addEventListener('change', () => {
      if (input.files && input.files.length) handle(input.files)
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
      if (e.dataTransfer.files && e.dataTransfer.files.length) handle(e.dataTransfer.files)
    })

    async function handle(files) {
      status.innerHTML = ''
      card.classList.remove('is-loaded')
      try {
        const result = await onFiles(files)
        card.classList.add('is-loaded')
        const rej = result.rejeitados
          ? ` <span class="conc-origem-tag">${result.rejeitados} ignorado(s)</span>`
          : ''
        status.innerHTML = `<span class="dot"></span> ${escapeHtml(result.fileName)} — ${result.rows.length} nota(s)${rej}`
        updateConciliarButton()
      } catch (err) {
        card.classList.remove('is-loaded')
        const isImportErr =
          (Parsers.ServicosImportError && err instanceof Parsers.ServicosImportError) ||
          (window.ConciliacaoParsers &&
            window.ConciliacaoParsers.ConciliacaoImportError &&
            err instanceof window.ConciliacaoParsers.ConciliacaoImportError)
        showToast(isImportErr ? err.message : 'Não foi possível ler o arquivo.', 'error')
        status.innerHTML = ''
      }
    }
  }

  function updateConciliarButton() {
    el('btnConciliar').disabled = !(state.nfse && state.sistema)
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
      const nfseRows = state.nfse.rows
      const sistemaRows = state.sistema.rows
      const indices = Engine.buildIndices(sistemaRows)
      for (const item of indices.todas) item._usado = false

      let overrides = new Map()
      try {
        // não deixa um IndexedDB travado (aba privada, file://) bloquear a conciliação
        overrides = await Promise.race([
          Storage.getAllOverrides(),
          new Promise((resolve) => setTimeout(() => resolve(new Map()), 3000)),
        ])
      } catch (e) {
        console.warn('IndexedDB indisponível — seguindo sem persistência', e)
      }

      const results = []
      for (let i = 0; i < nfseRows.length; i++) {
        const row = nfseRows[i]
        const overrideId = Engine.overrideId(row)
        const override = overrides.get(overrideId)
        const justificativa = (override && override.justificativa) || 'NÃO PRECISA'
        const observacao = (override && override.observacao) || ''
        const status = Engine.conciliar(row, indices, justificativa)

        const lancamento = Engine.encontraLancamento(row, indices)
        if (lancamento) lancamento._usado = true

        results.push(
          Object.assign({}, row, {
            key: `${overrideId}#${i}`,
            overrideId,
            justificativa,
            observacao,
            status,
          })
        )
        if (i % 50 === 0) {
          updateProgress(Math.round((i / nfseRows.length) * 100))
          await nextTick()
        }
      }

      state.indices = indices
      state.reconciled = results
      state.reconciledByKey = new Map(results.map((r) => [r.key, r]))
      state.sistemaSemNfse = indices.todas.filter((s) => !s._usado && s.nf).length
      state.page = 1

      renderHeader()
      renderFilterOptions()
      renderStats()
      renderTable()

      try {
        const stats = Engine.computeStats(results)
        await Storage.addHistoryEntry({
          nfseFileName: state.nfse.fileName,
          sistemaFileName: state.sistema.fileName,
          totalNotas: stats.total,
          lancadas: stats.porStatus['LANÇADA'] ? stats.porStatus['LANÇADA'].qtd : 0,
          naoLancadas: stats.porStatus['NÃO LANÇADA'] ? stats.porStatus['NÃO LANÇADA'].qtd : 0,
          responsavel: el('inputResponsavel').value || '',
        })
      } catch (e) {
        /* histórico é best-effort */
      }

      el('btnExportAll').disabled = false
      el('btnExportFiltered').disabled = false
      el('btnExportBundle').disabled = false
      el('emptyState').style.display = 'none'
      showToast(`Conciliação concluída — ${results.length} NFS-e processadas`, 'success')
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
    el('progressLabel').textContent = `Processando NFS-e... ${pct}%`
  }

  function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  function renderHeader() {
    const rows = state.nfse ? state.nfse.rows : []
    const { mes, ano } = Engine.detectMesAno(rows)
    el('reportTitle').textContent = `NOTAS DE SERVIÇO | ${mes} ${ano}`
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
    multiSelects.get('filterPrestador').setOptions(uniqueSorted(rows, 'prestador'))
    multiSelects.get('filterCnpj').setOptions(uniqueSorted(rows, 'prestadorCnpjFormatado'))
    multiSelects.get('filterMunicipio').setOptions(uniqueSorted(rows, 'municipio'))
    multiSelects.get('filterCodServico').setOptions(uniqueSorted(rows, 'codServico'))
    multiSelects
      .get('filterJustificativa')
      .setOptions(Engine.JUSTIFICATIVA_OPCOES, (v) => JUSTIFICATIVA_LABELS[v] || v)
    el('filtersBar').style.display = 'flex'
  }

  function readFilters() {
    const f = {
      status: multiSelects.get('filterStatus').getValues(),
      prestador: multiSelects.get('filterPrestador').getValues(),
      cnpj: multiSelects.get('filterCnpj').getValues(),
      municipio: multiSelects.get('filterMunicipio').getValues(),
      codServico: multiSelects.get('filterCodServico').getValues(),
      justificativa: multiSelects.get('filterJustificativa').getValues(),
      iss: el('filterIss').value,
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
    ;['filterStatus', 'filterPrestador', 'filterCnpj', 'filterMunicipio', 'filterCodServico', 'filterJustificativa'].forEach(
      (id) => multiSelects.get(id).clear()
    )
    el('filterIss').value = ''
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
      const isIss = card.key === '__iss__'
      let qtd
      let pct
      if (isTotal) {
        qtd = stats.total
        pct = 100
      } else if (isIss) {
        qtd = stats.comIss
        pct = stats.total ? (stats.comIss / stats.total) * 100 : 0
      } else {
        qtd = stats.porStatus[card.key] ? stats.porStatus[card.key].qtd : 0
        pct = stats.porStatus[card.key] ? stats.porStatus[card.key].pct : 0
      }

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'conc-stat-card' + (isTotal ? ' conc-stat-card--total' : '')
      if (isIss && el('filterIss').value === 'com') btn.classList.add('is-active')
      if (!isTotal && !isIss && activeStatuses.includes(card.key)) btn.classList.add('is-active')
      btn.innerHTML = `
        <div class="label">${escapeHtml(card.label)}</div>
        <div class="value">${qtd.toLocaleString('pt-BR')}</div>
        ${isTotal ? '' : `<div class="pct">${pct.toFixed(1)}%</div>`}
      `
      btn.addEventListener('click', () => {
        if (isTotal) {
          statusFilter.clear()
          el('filterIss').value = ''
        } else if (isIss) {
          el('filterIss').value = el('filterIss').value === 'com' ? '' : 'com'
        } else {
          const current = statusFilter.getValues()
          const next = current.includes(card.key)
            ? current.filter((v) => v !== card.key)
            : current.concat(card.key)
          statusFilter.setValues(next)
        }
        state.page = 1
        renderStats()
        renderTable()
      })
      grid.appendChild(btn)
    }

    const valorSelecionado = getFilteredRows().reduce((sum, row) => sum + (row.valorServico || 0), 0)
    const extra = [
      { label: 'Total em Valor', value: currencyFmt.format(stats.valorTotal) },
      { label: 'Valor Selecionado', value: currencyFmt.format(valorSelecionado) },
      { label: 'Valor Não Lançado', value: currencyFmt.format(stats.valorNaoLancado) },
      { label: 'ISS nas Notas', value: currencyFmt.format(stats.valorIss) },
      { label: 'Sistema s/ NFS-e', value: state.sistemaSemNfse.toLocaleString('pt-BR') },
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
    const map = {
      'LANÇADA': 'badge--recebida',
      'NÃO LANÇADA': 'badge--nao-lancada',
      'A LANÇAR': 'badge--falta-chegar',
      CANCELADA: 'badge--cancelada',
      DISPENSADA: 'badge--neutro',
    }
    return map[status] || 'badge--neutro'
  }

  function sortRows(rows) {
    const { key, dir } = state.sort
    const mult = dir === 'asc' ? 1 : -1
    const numeric = new Set(['numero', 'valorServico', 'iss'])
    return rows.slice().sort((a, b) => {
      let av = a[key]
      let bv = b[key]
      if (key === 'emissao') {
        av = av ? av.getTime() : 0
        bv = bv ? bv.getTime() : 0
        return (av - bv) * mult
      }
      if (numeric.has(key)) {
        av = key === 'numero' ? parseInt(Base.normalizeNF(av), 10) || 0 : Number(av) || 0
        bv = key === 'numero' ? parseInt(Base.normalizeNF(bv), 10) || 0 : Number(bv) || 0
        return (av - bv) * mult
      }
      return String(av || '').localeCompare(String(bv || ''), 'pt-BR') * mult
    })
  }

  const DANFSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 15.5h4"/></svg>'

  function td(text, className) {
    const cell = document.createElement('td')
    if (className) cell.className = className
    cell.textContent = text == null ? '' : text
    return cell
  }

  function danfseCell(row) {
    const cell = document.createElement('td')
    cell.className = 'col-chave'
    if (row.xml) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'conc-chave-btn serv-danfse-btn'
      btn.dataset.key = row.key
      btn.title = 'Abrir a DANFSe desta NFS-e'
      btn.setAttribute('aria-label', 'Abrir a DANFSe')
      btn.innerHTML = DANFSE_SVG
      cell.appendChild(btn)
    } else {
      cell.textContent = '—'
      cell.title = 'DANFSe indisponível — reimporte o lote de XML'
    }
    return cell
  }

  function issCell(row) {
    const cell = document.createElement('td')
    cell.className = 'col-valor'
    if (!row.temIss) {
      cell.textContent = '—'
      cell.classList.add('col-iss-zero')
      return cell
    }
    const valor = document.createElement('span')
    valor.textContent = currencyFmt.format(row.iss)
    cell.appendChild(valor)
    const tag = document.createElement('span')
    tag.className = 'serv-iss-tag' + (row.issRetido ? ' serv-iss-tag--retido' : '')
    tag.textContent = row.issRetido ? 'RETIDO' : 'ISS'
    tag.title = row.issRetido
      ? 'ISS retido pelo tomador (recolhido por nós)'
      : `ISS destacado${row.issAliquota ? ` — alíquota ${row.issAliquota}%` : ''}`
    cell.appendChild(tag)
    return cell
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
      if (row.cancelada) tr.classList.add('serv-row--cancelada')

      tr.appendChild(danfseCell(row))
      tr.appendChild(td(row.numero))
      tr.appendChild(td(row.serie))
      tr.appendChild(td(row.emissao ? Base.formatDateBR(row.emissao) : row.emissaoRaw))
      tr.appendChild(td(row.prestadorCnpjFormatado))
      tr.appendChild(td(row.prestador))
      tr.appendChild(td(row.municipio))
      tr.appendChild(td(row.codServico || ''))
      tr.appendChild(td(currencyFmt.format(row.valorServico), 'col-valor'))
      tr.appendChild(issCell(row))

      const statusTd = document.createElement('td')
      if (row.status) {
        const badge = document.createElement('span')
        badge.className = `badge ${statusClass(row.status)}`
        badge.textContent = row.status
        statusTd.appendChild(badge)
      }
      tr.appendChild(statusTd)

      const descTd = document.createElement('td')
      descTd.className = 'col-descricao'
      if (row.descricao) {
        const link = document.createElement('button')
        link.type = 'button'
        link.className = 'serv-desc-link'
        link.dataset.key = row.key
        link.textContent = row.descricao
        link.title = 'Ver a descrição completa'
        descTd.appendChild(link)
      }
      tr.appendChild(descTd)

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
      if (!icon) return
      if (th.dataset.sort === state.sort.key) icon.textContent = state.sort.dir === 'asc' ? '↑' : '↓'
      else icon.textContent = '↕'
    })
  }

  // -----------------------------------------------------------------------
  // Modal (DANFSe / descrição completa)
  // -----------------------------------------------------------------------

  let modalCleanup = null

  function openModal(title, wide) {
    el('servModalBox').className = 'conc-modal' + (wide ? ' conc-modal--danfse' : '')
    el('servModalTitle').textContent = title
    el('servModalActions').innerHTML = ''
    el('servModalBody').innerHTML = ''
    el('servModalOverlay').hidden = false
    document.addEventListener('keydown', onModalKey)
  }

  function closeModal() {
    el('servModalOverlay').hidden = true
    el('servModalBody').innerHTML = ''
    document.removeEventListener('keydown', onModalKey)
    if (modalCleanup) {
      modalCleanup()
      modalCleanup = null
    }
  }

  function onModalKey(e) {
    if (e.key === 'Escape') closeModal()
  }

  function openDescricao(row) {
    openModal(`Descrição — NFS-e ${row.numero || ''}`, false)
    const body = el('servModalBody')
    const meta = document.createElement('p')
    meta.className = 'serv-desc-meta'
    meta.textContent = `${row.prestador} · Cód. serviço ${row.codServico || '—'}`
    const full = document.createElement('div')
    full.className = 'serv-desc-full'
    full.textContent = row.descricao || ''
    body.append(meta, full)
  }

  function openDanfse(row) {
    if (!row.xml || !Danfse) {
      showToast('DANFSe indisponível para esta nota. Reimporte o lote de XML.', 'error')
      return
    }
    const html = Danfse.buildHtml(row.xml, { uf: row.uf, cancelada: row.cancelada })
    openModal(`DANFSe — NFS-e ${row.numero || ''}`, true)

    const actions = el('servModalActions')
    const btnPrint = document.createElement('button')
    btnPrint.type = 'button'
    btnPrint.className = 'conc-btn'
    btnPrint.textContent = 'Imprimir'
    const btnTab = document.createElement('button')
    btnTab.type = 'button'
    btnTab.className = 'conc-btn'
    btnTab.textContent = 'Abrir em nova aba'
    actions.append(btnPrint, btnTab)

    const iframe = document.createElement('iframe')
    iframe.className = 'serv-danfse-frame'
    iframe.setAttribute('title', 'DANFSe')
    iframe.srcdoc = html
    el('servModalBody').appendChild(iframe)

    btnPrint.addEventListener('click', () => {
      try {
        iframe.contentWindow.focus()
        iframe.contentWindow.print()
      } catch (e) {
        showToast('Não foi possível imprimir. Use "Abrir em nova aba".', 'error')
      }
    })
    let blobUrl = null
    btnTab.addEventListener('click', () => {
      blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      window.open(blobUrl, '_blank', 'noopener')
    })
    modalCleanup = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }

  // -----------------------------------------------------------------------
  // Edição inline
  // -----------------------------------------------------------------------

  function setupInlineEdit() {
    const tbody = el('tableBody')
    tbody.addEventListener('change', (e) => {
      if (e.target.matches('.justificativa-select')) onJustificativaChange(e.target)
      else if (e.target.matches('.observacao-input')) onObservacaoChange(e.target)
    })
    tbody.addEventListener('click', (e) => {
      const danfseBtn = e.target.closest('.serv-danfse-btn')
      if (danfseBtn) {
        const row = state.reconciledByKey.get(danfseBtn.dataset.key)
        if (row) openDanfse(row)
        return
      }
      const descBtn = e.target.closest('.serv-desc-link')
      if (descBtn) {
        const row = state.reconciledByKey.get(descBtn.dataset.key)
        if (row) openDescricao(row)
      }
    })

    el('servModalClose').addEventListener('click', closeModal)
    el('servModalOverlay').addEventListener('click', (e) => {
      if (e.target === el('servModalOverlay')) closeModal()
    })
  }

  function onJustificativaChange(target) {
    const row = state.reconciledByKey.get(target.dataset.key)
    if (!row) return
    row.justificativa = target.value
    row.status = Engine.conciliar(row, state.indices, row.justificativa)
    persistOverride(row)
    renderStats()
    renderTable()
  }

  function onObservacaoChange(target) {
    const row = state.reconciledByKey.get(target.dataset.key)
    if (!row) return
    row.observacao = target.value
    persistOverride(row)
  }

  function persistOverride(row) {
    Storage.saveOverride(row.overrideId, {
      justificativa: row.justificativa,
      observacao: row.observacao,
    }).catch((err) => console.error('Falha ao salvar edição', err))
  }

  // -----------------------------------------------------------------------
  // Exportação
  // -----------------------------------------------------------------------

  function exportRows(rows, filename) {
    const data = rows.map((r) => ({
      Chave: r.chave,
      'Nº NFS-e': r.numero,
      Série: r.serie,
      Emissão: r.emissao ? Base.formatDateBR(r.emissao) : r.emissaoRaw,
      Competência: r.competencia,
      'CNPJ Prestador': r.prestadorCnpjFormatado,
      Prestador: r.prestador,
      Município: r.municipio,
      UF: r.uf,
      'Cód. Serviço': r.codServico,
      'Valor Serviço': r.valorServico,
      'Valor Líquido': r.valorLiquido,
      ISS: r.iss,
      'ISS Retido': r.temIss ? (r.issRetido ? 'Sim' : 'Não') : '',
      Status: r.status,
      Justificativa: JUSTIFICATIVA_LABELS[r.justificativa] || r.justificativa,
      Observação: r.observacao,
      Descrição: r.descricao,
    }))
    const ws = window.XLSX.utils.json_to_sheet(data)
    const wb = window.XLSX.utils.book_new()
    window.XLSX.utils.book_append_sheet(wb, ws, 'Serviços')
    window.XLSX.writeFile(wb, filename)
  }

  // -----------------------------------------------------------------------
  // Exportar / importar (.json)
  // -----------------------------------------------------------------------

  const BUNDLE_FORMATO = 'conciliacao-servicos'
  const BUNDLE_VERSAO = 1

  function rowToPlain(r) {
    return {
      chave: r.chave,
      numero: r.numero,
      dps: r.dps,
      serie: r.serie,
      emissao: r.emissao ? Base.formatDateBR(r.emissao).split('/').reverse().join('-') : '',
      emissaoRaw: r.emissaoRaw,
      competencia: r.competencia,
      prestadorCnpj: r.prestadorCnpj,
      prestadorCnpjFormatado: r.prestadorCnpjFormatado,
      prestador: r.prestador,
      municipio: r.municipio,
      uf: r.uf,
      codServico: r.codServico,
      descricao: r.descricao,
      valorServico: r.valorServico,
      valorLiquido: r.valorLiquido,
      iss: r.iss,
      issAliquota: r.issAliquota,
      issRetido: r.issRetido,
      cStat: r.cStat,
      cancelada: r.cancelada,
      arquivo: r.arquivo,
      xml: r.xml || '',
    }
  }

  function exportBundle() {
    if (!state.nfse || !state.sistema || !state.reconciled.length) return
    const bundle = {
      formato: BUNDLE_FORMATO,
      versao: BUNDLE_VERSAO,
      geradoEm: new Date().toISOString(),
      responsavel: el('inputResponsavel').value || '',
      nfse: { fileName: state.nfse.fileName, rows: state.reconciled.map(rowToPlain) },
      sistema: { fileName: state.sistema.fileName, rawMatrix: state.sistema.rawMatrix },
      notas: state.reconciled.map((r) => ({
        id: r.overrideId,
        justificativa: r.justificativa,
        observacao: r.observacao || '',
      })),
    }
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' })
    const { mes, ano } = Engine.detectMesAno(state.nfse.rows)
    triggerDownload(blob, `servicos-${String(mes).toLowerCase()}-${ano}.json`)
    showToast('Arquivo exportado — envie-o por e-mail.', 'success')
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function importBundle(file) {
    let bundle
    try {
      bundle = JSON.parse(await file.text())
    } catch (e) {
      showToast('Não foi possível ler o arquivo. Selecione um .json exportado por esta página.', 'error')
      return
    }
    if (!bundle || bundle.formato !== BUNDLE_FORMATO || !bundle.nfse || !bundle.sistema) {
      showToast('Este arquivo não é uma conciliação de serviços exportada por esta página.', 'error')
      return
    }

    let sistema
    try {
      sistema = Parsers.sistemaRowsFromMatrix(bundle.sistema.rawMatrix)
      sistema.fileName = bundle.sistema.fileName || 'sistema-importado.xlsx'
    } catch (err) {
      showToast('Não foi possível reconstruir o arquivo do sistema do .json.', 'error')
      return
    }

    const nfseRows = Parsers.nfseRowsFromPlain(bundle.nfse.rows || [])
    if (!nfseRows.length) {
      showToast('O arquivo não contém NFS-e.', 'error')
      return
    }

    try {
      await Storage.saveOverridesBulk(
        (bundle.notas || [])
          .filter((n) => n && n.id)
          .map((n) => ({
            key: n.id,
            justificativa: n.justificativa || 'NÃO PRECISA',
            observacao: n.observacao || '',
          }))
      )
    } catch (err) {
      console.error('Falha ao salvar os dados alimentados importados', err)
    }

    state.nfse = { rows: nfseRows, fileName: bundle.nfse.fileName || 'nfse-importada', rejeitados: 0 }
    state.sistema = sistema

    if (bundle.responsavel) {
      el('inputResponsavel').value = bundle.responsavel
      try {
        localStorage.setItem('serv_responsavel', bundle.responsavel)
      } catch (e) {
        /* ignore */
      }
    }

    markCardLoaded('cardNfse', 'statusNfse', state.nfse.fileName, nfseRows.length)
    markCardLoaded('cardSistema', 'statusSistema', sistema.fileName, sistema.rows.length)
    renderHeader()
    updateConciliarButton()
    await runConciliacao()
  }

  function markCardLoaded(cardId, statusId, name, count) {
    el(cardId).classList.add('is-loaded')
    el(statusId).innerHTML = `<span class="dot"></span> ${escapeHtml(name)} — ${count} nota(s)`
  }

  // -----------------------------------------------------------------------
  // Bootstrap
  // -----------------------------------------------------------------------

  function bootstrap() {
    createMultiSelect('filterStatus', 'Status')
    createMultiSelect('filterPrestador', 'Prestador')
    createMultiSelect('filterCnpj', 'CNPJ')
    createMultiSelect('filterMunicipio', 'Município')
    createMultiSelect('filterCodServico', 'Cód. Serviço')
    createMultiSelect('filterJustificativa', 'Justificativa')

    setupUpload('cardNfse', 'dropNfse', 'inputNfse', 'statusNfse', async (files) => {
      const arr = Array.from(files)
      const result =
        arr.length === 1 && /\.(zip|xml)$/i.test(arr[0].name)
          ? await Parsers.parseNfseLote(arr[0])
          : await Parsers.parseNfseXmls(arr)
      state.nfse = result
      renderHeader()
      return result
    })

    setupUpload('cardSistema', 'dropSistema', 'inputSistema', 'statusSistema', async (files) => {
      const result = await Parsers.parseSistemaServicos(files[0])
      state.sistema = result
      return result
    })

    el('btnConciliar').addEventListener('click', runConciliacao)
    el('btnExportAll').addEventListener('click', () => exportRows(state.reconciled, 'conciliacao-servicos.xlsx'))
    el('btnExportFiltered').addEventListener('click', () =>
      exportRows(getFilteredRows(), 'conciliacao-servicos-filtrado.xlsx')
    )
    el('btnExportBundle').addEventListener('click', exportBundle)
    el('btnImportBundle').addEventListener('click', () => el('inputImportBundle').click())
    el('inputImportBundle').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0]
      if (file) importBundle(file)
      e.target.value = ''
    })

    ;['filterStatus', 'filterPrestador', 'filterCnpj', 'filterMunicipio', 'filterCodServico', 'filterJustificativa'].forEach(
      (id) =>
        el(id).addEventListener('change', () => {
          state.page = 1
          renderStats()
          renderTable()
        })
    )
    ;['filterIss', 'filterDataInicio', 'filterDataFim'].forEach((id) =>
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

    try {
      const saved = localStorage.getItem('serv_responsavel')
      if (saved) el('inputResponsavel').value = saved
    } catch (e) {
      /* ignore */
    }
    el('inputResponsavel').addEventListener('change', (e) => {
      try {
        localStorage.setItem('serv_responsavel', e.target.value)
      } catch (err) {
        /* ignore */
      }
    })
  }

  document.addEventListener('DOMContentLoaded', bootstrap)
})()
