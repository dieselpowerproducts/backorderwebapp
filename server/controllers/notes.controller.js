const notesService = require("../services/notes.service");
const productsService = require("../services/products.service");

async function listNotes(req, res, next) {
  try {
    const notes = await notesService.getNotesForSku(req.params.sku);
    res.send(notes);
  } catch (err) {
    next(err);
  }
}

async function getNotesBootstrap(req, res, next) {
  try {
    const [notes, productDetails] = await Promise.all([
      notesService.getNotesForSku(req.params.sku),
      productsService.getProductDetails(req.params.sku)
    ]);

    res.send({
      notes,
      productDetails
    });
  } catch (err) {
    next(err);
  }
}

async function createNote(req, res, next) {
  try {
    const result = await notesService.addNote(req.body, req.user);
    res.send({ id: result.id });
  } catch (err) {
    next(err);
  }
}

async function deleteNote(req, res, next) {
  try {
    const result = await notesService.deleteNote(req.params.id, req.user);
    res.send({ deleted: result.changes });
  } catch (err) {
    next(err);
  }
}

async function updateNote(req, res, next) {
  try {
    const result = await notesService.updateNote(req.params.id, req.body.note, req.user);
    res.send({ updated: result.changes });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getNotesBootstrap,
  listNotes,
  createNote,
  deleteNote,
  updateNote
};
