const express = require("express");
const notesController = require("../controllers/notes.controller");

const router = express.Router();

router.get("/notes/:sku/bootstrap", notesController.getNotesBootstrap);
router.get("/notes/:sku", notesController.listNotes);
router.post("/notes", notesController.createNote);
router.delete("/notes/:id", notesController.deleteNote);
router.put("/notes/:id", notesController.updateNote);

module.exports = router;
