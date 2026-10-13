// The relationship-graph tokenizers keep [a-z0-9] only, so whatever text reaches them must
// already spell its digits and letters in ASCII. Crawled descriptions do not: a numeric
// <sup>/<sub> arrives as a Unicode super- or subscript attached to the word ("SPF⁵⁰", "H₂O",
// "Vitamin B₅", "Ceramide¹"), and some titles use full-width Latin. Unfolded, those tokenize
// as "spf", "h₂o", "b" and "" — the digit is the distinguishing part, and it is the part lost.
// NFKC folds every one of them to ASCII.
//
// Marks go before NFKC, which would turn "Brand™" into "brandtm" and "Name℠" into "namesm".
// They become a space, so "Brand™" still tokenizes as "brand".
function foldTokenText(value) {
  return String(value == null ? '' : value)
    .replace(/[\u2122\u2120\u00ae\u00a9]/g, ' ')
    .normalize('NFKC');
}

module.exports = { foldTokenText };
