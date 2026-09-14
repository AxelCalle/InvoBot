const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const sql = require('mssql');
const { getPool } = require('../config/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');

// Todo el historial de chat requiere sesión iniciada; cada usuario solo ve el suyo.
router.use(requireAuth);

// Listar todos los hilos del usuario con sus mensajes, para sincronizar al
// iniciar sesión en cualquier computadora.
router.get('/threads', async (req, res) => {
  try {
    const pool = await getPool();
    const threadsRes = await pool.request()
      .input('usuarioId', sql.Int, req.user.id)
      .query('SELECT id, title, created_at, updated_at FROM chat_threads WHERE usuario_id = @usuarioId ORDER BY updated_at DESC');

    const threads = threadsRes.recordset;
    if (threads.length === 0) return res.json({ ok: true, threads: [] });

    const ids = threads.map(t => t.id);
    const msgRequest = pool.request();
    const idsParams = ids.map((id, i) => {
      msgRequest.input(`id${i}`, sql.VarChar, id);
      return `@id${i}`;
    }).join(',');
    const msgsRes = await msgRequest.query(
      `SELECT id, thread_id, role, [text], invoice_id, attachment_filename, attachment_mimetype, attachment_size, created_at
       FROM chat_messages WHERE thread_id IN (${idsParams}) ORDER BY created_at ASC`
    );

    const porHilo = {};
    for (const m of msgsRes.recordset) {
      if (!porHilo[m.thread_id]) porHilo[m.thread_id] = [];
      porHilo[m.thread_id].push({
        id: m.id,
        role: m.role,
        text: m.text,
        invoiceId: m.invoice_id || undefined,
        attachment: m.attachment_filename ? {
          filename: m.attachment_filename,
          mimeType: m.attachment_mimetype,
          size: m.attachment_size,
        } : undefined,
        createdAt: new Date(m.created_at).getTime(),
      });
    }

    const resultado = threads.map(t => ({
      id: t.id,
      title: t.title,
      createdAt: new Date(t.created_at).getTime(),
      updatedAt: new Date(t.updated_at).getTime(),
      messages: porHilo[t.id] || [],
    }));

    res.json({ ok: true, threads: resultado });
  } catch (err) {
    logger.error('Error listando hilos de chat', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Crear un hilo nuevo.
router.post('/threads', async (req, res) => {
  try {
    const pool = await getPool();
    const id = req.body.id || crypto.randomUUID();
    const title = req.body.title || 'Nueva conversación';
    await pool.request()
      .input('id', sql.VarChar, id)
      .input('usuarioId', sql.Int, req.user.id)
      .input('title', sql.NVarChar, title)
      .query('INSERT INTO chat_threads (id, usuario_id, title) VALUES (@id, @usuarioId, @title)');
    res.json({ ok: true });
  } catch (err) {
    logger.error('Error creando hilo de chat', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Renombrar un hilo.
router.patch('/threads/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.VarChar, req.params.id)
      .input('usuarioId', sql.Int, req.user.id)
      .input('title', sql.NVarChar, req.body.title || 'Sin título')
      .query('UPDATE chat_threads SET title = @title, updated_at = getdate() WHERE id = @id AND usuario_id = @usuarioId');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar un hilo (y sus mensajes).
router.delete('/threads/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.VarChar, req.params.id)
      .query('DELETE FROM chat_messages WHERE thread_id = @id');
    await pool.request()
      .input('id', sql.VarChar, req.params.id)
      .input('usuarioId', sql.Int, req.user.id)
      .query('DELETE FROM chat_threads WHERE id = @id AND usuario_id = @usuarioId');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agregar un mensaje a un hilo.
router.post('/threads/:id/messages', async (req, res) => {
  try {
    const pool = await getPool();
    const { id: msgId, role, text, invoiceId, attachment } = req.body;

    await pool.request()
      .input('id', sql.VarChar, msgId || crypto.randomUUID())
      .input('threadId', sql.VarChar, req.params.id)
      .input('role', sql.VarChar, role)
      .input('text', sql.NVarChar(sql.MAX), text || null)
      .input('invoiceId', sql.VarChar, invoiceId || null)
      .input('attFilename', sql.NVarChar, attachment?.filename || null)
      .input('attMimeType', sql.VarChar, attachment?.mimeType || null)
      .input('attSize', sql.Int, attachment?.size || null)
      .query(`INSERT INTO chat_messages
        (id, thread_id, role, [text], invoice_id, attachment_filename, attachment_mimetype, attachment_size)
        VALUES (@id, @threadId, @role, @text, @invoiceId, @attFilename, @attMimeType, @attSize)`);

    // Igual que en local: si es el primer archivo subido en una conversación sin
    // título propio, el título pasa a ser el nombre del archivo.
    let nuevoTitulo = null;
    if (role === 'user' && attachment) {
      const hiloRes = await pool.request()
        .input('id', sql.VarChar, req.params.id)
        .query('SELECT title FROM chat_threads WHERE id = @id');
      const tituloActual = hiloRes.recordset[0]?.title;
      if (['Nueva conversación', 'New conversation', 'Sin título'].includes(tituloActual)) {
        nuevoTitulo = attachment.filename.replace(/\.[^/.]+$/, '').slice(0, 40);
      }
    }

    const upd = pool.request()
      .input('id', sql.VarChar, req.params.id)
      .input('usuarioId', sql.Int, req.user.id);
    if (nuevoTitulo) {
      upd.input('title', sql.NVarChar, nuevoTitulo);
      await upd.query('UPDATE chat_threads SET updated_at = getdate(), title = @title WHERE id = @id AND usuario_id = @usuarioId');
    } else {
      await upd.query('UPDATE chat_threads SET updated_at = getdate() WHERE id = @id AND usuario_id = @usuarioId');
    }

    res.json({ ok: true, title: nuevoTitulo });
  } catch (err) {
    logger.error('Error guardando mensaje de chat', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
