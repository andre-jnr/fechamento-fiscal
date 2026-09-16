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
  const Danfe = window.ConciliacaoDanfe

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
    { key: 'SAÍDA DE ESTOQUE', label: 'Saída de Estoque' },
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
    document.querySelectorAll('.conc-link-dropdown.is-open').forEach((r) => {
      if (!r.contains(e.target)) r.classList.remove('is-open')
    })
  })

  function setupLinkDropdown(rootId, toggleId) {
    const root = el(rootId)
    const toggle = el(toggleId)
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = !root.classList.contains('is-open')
      closeAllMultiSelects()
      document.querySelectorAll('.conc-link-dropdown.is-open').forEach((r) => r.classList.remove('is-open'))
      if (willOpen) root.classList.add('is-open')
    })
  }

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
        status.innerHTML = `<span class="dot"></span> ${escapeHtml(file.name)} — ${result.rows.length} notas${sistemaOrigemSufixo(result.origem)}`
        updateConciliarButton()
      } catch (err) {
        card.classList.remove('is-loaded')
        const msg = err instanceof Parsers.ConciliacaoImportError ? err.message : Parsers.MSG_FORMATO_INVALIDO
        showToast(msg, 'error')
        status.innerHTML = ''
      }
    }
  }

  // Upload da SEFAZ: aceita CSV, .zip de XML, ou os dois juntos (arrasta/seleciona
  // mais de um arquivo). O CSV continua sendo a fonte de verdade pra SITUACAO/TIPO/
  // etc. quando presente — o .zip só entra pra anexar o XML de cada nota (pela
  // chave), habilitando o botão de DANFE. Sem CSV, o .zip sozinho tenta reconstruir
  // a linha inteira a partir do XML (ver `Parsers.parseSefazZip` — SITUACAO fica
  // como "AUTORIZADA" pra notas canceladas quando o zip não traz o evento de
  // cancelamento, uma limitação de dado, não de parsing).
  function setupSefazUpload(cardId, dropId, inputId, statusId) {
    const card = el(cardId)
    const drop = el(dropId)
    const input = el(inputId)
    const status = el(statusId)

    input.addEventListener('change', () => {
      if (input.files && input.files.length) handle(Array.from(input.files))
      input.value = ''
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
      const files = e.dataTransfer.files && Array.from(e.dataTransfer.files)
      if (files && files.length) handle(files)
    })

    async function handle(files) {
      status.innerHTML = ''
      card.classList.remove('is-loaded')
      const csvFile = files.find((f) => /\.csv$/i.test(f.name))
      const zipFile = files.find((f) => /\.zip$/i.test(f.name))
      if (!csvFile && !zipFile) {
        showToast('Selecione um arquivo .csv e/ou .zip da SEFAZ.', 'error')
        return
      }

      try {
        let result
        if (csvFile) {
          result = await Parsers.parseSefazCsv(csvFile)
          if (zipFile) result = await Parsers.attachXmlFromZip(result, zipFile)
        } else {
          result = await Parsers.parseSefazZip(zipFile)
        }

        state.sefaz = result
        renderHeader()
        card.classList.add('is-loaded')
        const nomes = [csvFile, zipFile].filter(Boolean).map((f) => f.name).join(' + ')
        const comXml = csvFile && zipFile ? ' <span class="conc-origem-tag">com DANFE</span>' : ''
        status.innerHTML = `<span class="dot"></span> ${escapeHtml(nomes)} — ${result.rows.length} notas${comXml}`
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

  const SISTEMA_ORIGEM_LABEL = { moura: 'Moura', atak: 'Atak' }

  function sistemaOrigemSufixo(origem) {
    const label = SISTEMA_ORIGEM_LABEL[origem]
    return label ? ` <span class="conc-origem-tag">${label}</span>` : ''
  }

  function updateConciliarButton() {
    el('btnConciliar').disabled = !(state.sefaz && state.sistema)
  }

  // Integração opcional com o conector-erp (servidor local, ver conector-erp/README.md):
  // só aparece quando a página é servida por ele (http://localhost:PORTA), nunca no
  // GitHub Pages — o upload manual do XLSX continua funcionando do mesmo jeito.
  function setupConectorErp() {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return

    const wrap = el('conectorErp')
    const selectUnidade = el('conectorUnidade')
    const inputDe = el('conectorDe')
    const inputAte = el('conectorAte')
    const btn = el('btnConectorBuscar')
    const status = el('statusConectorErp')

    const hoje = new Date()
    const primeiroDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
    inputDe.value = primeiroDoMes.toISOString().slice(0, 10)
    inputAte.value = hoje.toISOString().slice(0, 10)

    fetch('/api/unidades')
      .then((r) => r.json())
      .then((unidades) => {
        selectUnidade.innerHTML = unidades
          .map((u) => `<option value="${escapeHtml(u.chave)}">${escapeHtml(u.nome)}</option>`)
          .join('')
        wrap.hidden = false
      })
      .catch(() => {
        // Sem conector-erp rodando (ex.: Live Server na porta 5501) — não mostra o bloco.
      })

    btn.addEventListener('click', async () => {
      const unidade = selectUnidade.value
      const de = inputDe.value
      const ate = inputAte.value
      if (!unidade || !de || !ate) {
        showToast('Selecione a unidade e o período.', 'error')
        return
      }

      const card = el('cardSistema')
      btn.disabled = true
      card.classList.remove('is-loaded')
      status.innerHTML = '<span class="dot"></span> Buscando...'

      try {
        const resp = await fetch(`/api/sistema?unidade=${encodeURIComponent(unidade)}&de=${de}&ate=${ate}`)
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.erro || 'Falha ao buscar do sistema.')

        const result = Parsers.sistemaRowsFromMatrix(data.rawMatrix)
        result.fileName = `sistema-${unidade}-${de}-a-${ate}.xlsx`
        state.sistema = result
        card.classList.add('is-loaded')
        status.innerHTML = `<span class="dot"></span> ${result.rows.length} notas${sistemaOrigemSufixo(result.origem)}`
        updateConciliarButton()
      } catch (err) {
        status.innerHTML = ''
        const msg = err instanceof Parsers.ConciliacaoImportError ? err.message : err.message || Parsers.MSG_FORMATO_INVALIDO
        showToast(msg, 'error')
      } finally {
        btn.disabled = false
      }
    })
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
          const overrideId = Engine.overrideId(row)
          const override = overrides.get(overrideId)
          const justificativa = (override && override.justificativa) || 'NÃO PRECISA'
          const observacao = (override && override.observacao) || ''
          const unidade = Engine.unidadeNome(row.cnpjDestinatario)
          const status = Engine.conciliarNota(row, indices, justificativa)
          // Prioridade pro XML da própria SEFAZ (quando o arquivo importado foi um
          // .zip de XML — ver Parsers.parseSefazZip): nesse caso toda nota já tem o
          // próprio XML, então o botão de DANFE aparece em todas as linhas. Só cai
          // pro XML casado no sistema (via conector-erp) quando a SEFAZ veio do CSV
          // (sem XML nenhum).
          const chaveDigits = Engine.chaveAcessoDigits(row.chave)
          const xml = row.xml || (chaveDigits ? indices.xmlPorChave.get(chaveDigits) || '' : '')
          results.push(Object.assign({}, row, { key, overrideId, unidade, justificativa, observacao, status, xml }))
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
      el('btnExportBundle').disabled = false
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

      tr.appendChild(danfeCell(row))
      tr.appendChild(chaveCell(row))
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

  const CLIPBOARD_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'

  const DANFE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 15.5h4"/></svg>'

  // Só existe quando o sistema veio do conector-erp (busca direto no banco, que traz
  // o XML da NF-e) — upload manual do XLSX nunca preenche row.xml, então a coluna
  // fica vazia (sem botão) nesse caso, sem quebrar nada.
  function danfeCell(row) {
    const cell = document.createElement('td')
    cell.className = 'col-chave'
    if (row.xml) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'conc-chave-btn conc-danfe-btn'
      btn.dataset.key = row.key
      btn.title = 'Abrir a DANFE desta NF-e'
      btn.setAttribute('aria-label', 'Abrir a DANFE')
      btn.innerHTML = DANFE_SVG
      cell.appendChild(btn)
    } else {
      cell.textContent = '—'
    }
    return cell
  }

  function chaveCell(row) {
    const cell = document.createElement('td')
    cell.className = 'col-chave'
    if (row.chave) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'conc-chave-btn'
      btn.dataset.chave = row.chave
      btn.title = `Copiar chave: ${row.chave}`
      btn.setAttribute('aria-label', 'Copiar chave da nota')
      btn.innerHTML = CLIPBOARD_SVG
      cell.appendChild(btn)
    } else {
      cell.textContent = '—'
    }
    return cell
  }

  function copyToClipboard(text, successMsg) {
    if (!text) return
    const ok = () => showToast(successMsg, 'success')
    const fail = () =>
      showToast('Não foi possível copiar automaticamente. Selecione e copie manualmente.', 'error')
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => {
        if (legacyCopy(text)) ok()
        else fail()
      })
    } else if (legacyCopy(text)) {
      ok()
    } else {
      fail()
    }
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const done = document.execCommand('copy')
      ta.remove()
      return done
    } catch (e) {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Modal da DANFE (só quando o sistema veio do conector-erp — ver danfeCell)
  // -----------------------------------------------------------------------

  let danfeModalCleanup = null

  function openDanfeModal(title) {
    el('danfeModalBox').className = 'conc-modal conc-modal--danfe'
    el('danfeModalTitle').textContent = title
    el('danfeModalActions').innerHTML = ''
    el('danfeModalBody').innerHTML = ''
    el('danfeModalOverlay').hidden = false
    document.addEventListener('keydown', onDanfeModalKey)
  }

  function closeDanfeModal() {
    el('danfeModalOverlay').hidden = true
    el('danfeModalBody').innerHTML = ''
    document.removeEventListener('keydown', onDanfeModalKey)
    if (danfeModalCleanup) {
      danfeModalCleanup()
      danfeModalCleanup = null
    }
  }

  function onDanfeModalKey(e) {
    if (e.key === 'Escape') closeDanfeModal()
  }

  function openDanfe(row) {
    if (!row.xml || !Danfe) {
      showToast('DANFE indisponível para esta nota.', 'error')
      return
    }
    const html = Danfe.buildHtml(row.xml, { cancelada: row.situacao === 'CANCELADA' })
    openDanfeModal(`DANFE — NF-e ${row.nf || ''}`)

    const actions = el('danfeModalActions')
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
    iframe.className = 'danfe-frame'
    iframe.setAttribute('title', 'DANFE')
    iframe.srcdoc = html
    el('danfeModalBody').appendChild(iframe)

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
    danfeModalCleanup = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }

  function setupDanfeModal() {
    if (!el('danfeModalOverlay')) return
    el('danfeModalClose').addEventListener('click', closeDanfeModal)
    el('danfeModalOverlay').addEventListener('click', (e) => {
      if (e.target === el('danfeModalOverlay')) closeDanfeModal()
    })
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
    tbody.addEventListener('click', (e) => {
      const danfeBtn = e.target.closest('.conc-danfe-btn')
      if (danfeBtn) {
        const row = state.reconciledByKey.get(danfeBtn.dataset.key)
        if (row) openDanfe(row)
        return
      }
      const btn = e.target.closest('.conc-chave-btn')
      if (btn) copyToClipboard(btn.dataset.chave, 'Chave copiada para a área de transferência.')
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

  const RELATORIO_TEMPLATE_URL = 'assets/relatorio-fiscal.xlsx'

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
  // Exportar / importar conciliação (.json)
  //
  // Um único arquivo com os dados brutos da SEFAZ e do sistema + tudo o que
  // foi alimentado (justificativa e observação por nota, identificadas pela
  // chave de acesso). Quem recebe importa só esse arquivo e o relatório
  // inteiro é reconstruído — sem precisar dos CSV/XLSX originais.
  // -----------------------------------------------------------------------

  const BUNDLE_FORMATO = 'conciliacao-fiscal'
  const BUNDLE_VERSAO = 1

  function exportBundle() {
    if (!state.sefaz || !state.sistema || !state.reconciled.length) return
    const bundle = {
      formato: BUNDLE_FORMATO,
      versao: BUNDLE_VERSAO,
      geradoEm: new Date().toISOString(),
      responsavel: el('inputResponsavel').value || '',
      sefaz: { fileName: state.sefaz.fileName, rawMatrix: state.sefaz.rawMatrix },
      sistema: { fileName: state.sistema.fileName, rawMatrix: state.sistema.rawMatrix },
      notas: state.reconciled.map((r) => ({
        id: r.overrideId,
        chave: r.chave || '',
        nf: r.nf,
        justificativa: r.justificativa,
        observacao: r.observacao || '',
      })),
    }

    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' })
    const { mes, ano } = Engine.detectMesAno(state.sefaz.rows)
    triggerDownload(blob, `conciliacao-${String(mes).toLowerCase()}-${ano}.json`)
    showToast('Arquivo de conciliação exportado — envie-o por e-mail.', 'success')
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

  function markCardLoaded(cardId, statusId, name, count, origem) {
    el(cardId).classList.add('is-loaded')
    el(statusId).innerHTML = `<span class="dot"></span> ${escapeHtml(name)} — ${count} notas${sistemaOrigemSufixo(origem)}`
  }

  async function importBundle(file) {
    let bundle
    try {
      bundle = JSON.parse(await file.text())
    } catch (e) {
      showToast('Não foi possível ler o arquivo. Selecione um .json exportado por esta página.', 'error')
      return
    }
    if (!bundle || bundle.formato !== BUNDLE_FORMATO || !bundle.sefaz || !bundle.sistema) {
      showToast('Este arquivo não é um relatório de conciliação exportado por esta página.', 'error')
      return
    }

    let sefaz
    let sistema
    try {
      sefaz = Parsers.sefazRowsFromMatrix(bundle.sefaz.rawMatrix)
      sefaz.fileName = bundle.sefaz.fileName || 'conciliacao-importada.csv'
      sistema = Parsers.sistemaRowsFromMatrix(bundle.sistema.rawMatrix)
      sistema.fileName = bundle.sistema.fileName || 'conciliacao-importada.xlsx'
    } catch (err) {
      const msg =
        err instanceof Parsers.ConciliacaoImportError ? err.message : Parsers.MSG_FORMATO_INVALIDO
      showToast(msg, 'error')
      return
    }

    // Grava o que foi alimentado antes de conciliar — assim a conciliação já
    // aplica as justificativas/observações do arquivo importado. Fica salvo
    // localmente, então importações futuras de SEFAZ/sistema mantêm os dados.
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

    state.sefaz = sefaz
    state.sistema = sistema

    if (bundle.responsavel) {
      el('inputResponsavel').value = bundle.responsavel
      localStorage.setItem('conc_responsavel', bundle.responsavel)
    }

    markCardLoaded('cardSefaz', 'statusSefaz', sefaz.fileName, sefaz.rows.length)
    markCardLoaded('cardSistema', 'statusSistema', sistema.fileName, sistema.rows.length, sistema.origem)
    renderHeader()
    updateConciliarButton()

    await runConciliacao()
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

    setupLinkDropdown('dropdownSistema', 'btnSistema')

    setupSefazUpload('cardSefaz', 'dropSefaz', 'inputSefaz', 'statusSefaz')

    setupUpload('cardSistema', 'dropSistema', 'inputSistema', 'statusSistema', async (file) => {
      const result = await Parsers.parseSistemaXlsx(file)
      state.sistema = result
      return result
    })

    setupConectorErp()

    el('btnConciliar').addEventListener('click', runConciliacao)
    el('btnExportAll').addEventListener('click', () => exportRows(state.reconciled, 'conciliacao-fiscal.xlsx'))
    el('btnExportFiltered').addEventListener('click', () => exportRows(getFilteredRows(), 'conciliacao-fiscal-filtrado.xlsx'))
    el('btnRelatorioFormatado').addEventListener('click', gerarRelatorioFormatado)
    el('btnExportBundle').addEventListener('click', exportBundle)
    el('btnImportBundle').addEventListener('click', () => el('inputImportBundle').click())
    el('inputImportBundle').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0]
      if (file) importBundle(file)
      e.target.value = ''
    })

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
    setupDanfeModal()

    const savedResponsavel = localStorage.getItem('conc_responsavel')
    if (savedResponsavel) el('inputResponsavel').value = savedResponsavel
    el('inputResponsavel').addEventListener('change', (e) =>
      localStorage.setItem('conc_responsavel', e.target.value)
    )

    setupNovidades()
  }

  // -----------------------------------------------------------------------
  // Aviso de novidades — aparece uma única vez por navegador na primeira
  // abertura após a atualização de setembro.
  // -----------------------------------------------------------------------

  // _v2: conteúdo trocado (DANFE, .zip da SEFAZ, Atak, conector-erp) — muda a chave
  // pra quem já tinha visto a versão antiga (3 itens) ver o aviso de novo.
  const NOVIDADES_KEY = 'conc_novidades_setembro_2026_v2'

  function setupNovidades() {
    const overlay = el('novidadesOverlay')
    if (!overlay) return

    let jaViu = false
    try {
      jaViu = localStorage.getItem(NOVIDADES_KEY) === '1'
    } catch (e) {
      /* localStorage indisponível — mostra o aviso mesmo assim */
    }
    if (jaViu) return

    function fechar() {
      overlay.hidden = true
      document.removeEventListener('keydown', onKey)
      try {
        localStorage.setItem(NOVIDADES_KEY, '1')
      } catch (e) {
        /* ignora */
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') fechar()
    }

    overlay.hidden = false
    el('btnNovidadesOk').addEventListener('click', fechar)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) fechar()
    })
    document.addEventListener('keydown', onKey)
  }

  document.addEventListener('DOMContentLoaded', bootstrap)
})()
