// RSC classic names are base37: space and underscore are the same character.
// The client sends spaces as underscores ("Kale_Stille"), the in-game name
// decodes to spaces ("kale stille"). Every lookup and every insert must use
// this one form, or an account registered under one spelling cannot be found
// under the other.
function normalizeUsername(username) {
    return String(username).replace(/_/g, ' ').trim().toLowerCase();
}

module.exports = { normalizeUsername };
