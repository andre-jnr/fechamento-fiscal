/**
 * Persistência local (IndexedDB) — não há backend neste projeto (site
 * estático). Guarda as edições de Justificativa/Observação por nota
 * (chave = CNPJ Emissor + NF + Série + Valor + Emissão) e o histórico de
 * importações.
 */
;(function (global) {
  'use strict'

  const DB_NAME = 'conciliacao-fiscal'
  const DB_VERSION = 1
  const STORE_OVERRIDES = 'noteOverrides'
  const STORE_HISTORY = 'importHistory'

  let dbPromise = null

  function openDB() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_OVERRIDES)) {
          db.createObjectStore(STORE_OVERRIDES, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(STORE_HISTORY)) {
          db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return dbPromise
  }

  function tx(storeName, mode) {
    return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName))
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async function getAllOverrides() {
    const store = await tx(STORE_OVERRIDES, 'readonly')
    const all = await promisifyRequest(store.getAll())
    const map = new Map()
    for (const entry of all) map.set(entry.key, entry)
    return map
  }

  async function saveOverride(key, data) {
    const store = await tx(STORE_OVERRIDES, 'readwrite')
    return promisifyRequest(
      store.put({ key, justificativa: data.justificativa, observacao: data.observacao, updatedAt: Date.now() })
    )
  }

  async function addHistoryEntry(entry) {
    const store = await tx(STORE_HISTORY, 'readwrite')
    return promisifyRequest(store.add({ ...entry, timestamp: Date.now() }))
  }

  async function getHistory() {
    const store = await tx(STORE_HISTORY, 'readonly')
    const all = await promisifyRequest(store.getAll())
    return all.sort((a, b) => b.timestamp - a.timestamp)
  }

  global.ConciliacaoStorage = {
    getAllOverrides,
    saveOverride,
    addHistoryEntry,
    getHistory,
  }
})(typeof window !== 'undefined' ? window : globalThis)
