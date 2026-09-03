/**
 * Persistência local (IndexedDB) da conciliação de serviços. Guarda o que o
 * usuário alimenta por nota (Justificativa/Observação), com chave =
 * `ServicosEngine.overrideId` (a chave de acesso da NFS-e — 50 dígitos —
 * quando existe, com fallback para a chave composta).
 */
;(function (global) {
  'use strict'

  const DB_NAME = 'conciliacao-servicos'
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
      store.put({
        key,
        justificativa: data.justificativa,
        observacao: data.observacao,
        updatedAt: data.updatedAt || Date.now(),
      })
    )
  }

  async function saveOverridesBulk(list) {
    if (!list || !list.length) return
    const store = await tx(STORE_OVERRIDES, 'readwrite')
    await Promise.all(
      list.map((entry) =>
        promisifyRequest(
          store.put({
            key: entry.key,
            justificativa: entry.justificativa,
            observacao: entry.observacao,
            updatedAt: entry.updatedAt || Date.now(),
          })
        )
      )
    )
  }

  async function addHistoryEntry(entry) {
    const store = await tx(STORE_HISTORY, 'readwrite')
    return promisifyRequest(store.add({ ...entry, timestamp: Date.now() }))
  }

  global.ServicosStorage = {
    getAllOverrides,
    saveOverride,
    saveOverridesBulk,
    addHistoryEntry,
  }
})(typeof window !== 'undefined' ? window : globalThis)
