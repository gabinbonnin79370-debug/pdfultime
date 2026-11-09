const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

async function mergePDFs(filePaths, outputPath) {
  try {
    const mergedPdf = await PDFDocument.create();
    for (const filePath of filePaths) {
      const pdfBytes = fs.readFileSync(filePath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const mergedPdfBytes = await mergedPdf.save();
    fs.writeFileSync(outputPath, mergedPdfBytes);
    console.log(`✅ Fusion réussie ! Fichier généré : ${outputPath}`);
  } catch (error) {
    console.error('❌ Erreur lors de la fusion :', error);
  }
}

// Assure-toi d'avoir mis doc1.pdf et doc2.pdf dans le même dossier
const filesToMerge = [
  path.join(__dirname, 'doc1.pdf'),
  path.join(__dirname, 'doc2.pdf')
];

mergePDFs(filesToMerge, path.join(__dirname, 'resultat_fusion.pdf'));