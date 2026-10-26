// Apply a player save (the playerUpdate message, minus token and handler) to
// the players table. Shared by playerUpdate and the Grand Exchange writes,
// which commit the save in the same transaction as the offer.

const PLAYER_BOOLEAN_PROPERTIES = [
    'cameraAuto',
    'oneMouseButton',
    'soundOn',
    'blockChat',
    'blockPrivateChat',
    'blockTrade',
    'blockDuel'
];

function savePlayer(queryHandler, save) {
    const player = { ...save };

    delete player.token;
    delete player.handler;

    for (const property of PLAYER_BOOLEAN_PROPERTIES) {
        player[property] = +player[property];
    }

    queryHandler.updatePlayer(player);
}

module.exports = { PLAYER_BOOLEAN_PROPERTIES, savePlayer };
