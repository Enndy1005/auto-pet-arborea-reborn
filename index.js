/* eslint-disable no-nested-ternary */
const path = require("path");

class Servant {
    constructor(info) {
        this.ID = Number(info.id);
        this.UniqueID = Number(info.dbid);
        this.Name = info.name;
    }
    stringify() {
        return {
            name: this.Name,
            id: this.ID.toString(),
            dbid: this.UniqueID.toString()
        };
    }
}

module.exports = function AutoPet(mod) {
    mod.dispatch.addDefinition("C_REQUEST_SPAWN_SERVANT", 1, path.join(__dirname, "defs", "C_REQUEST_SPAWN_SERVANT.1.def"));
    mod.dispatch.addDefinition("C_REQUEST_SPAWN_SERVANT", 2, path.join(__dirname, "defs", "C_REQUEST_SPAWN_SERVANT.2.def"));
    mod.dispatch.addDefinition("C_START_SERVANT_ACTIVE_SKILL", 1, path.join(__dirname, "defs", "C_START_SERVANT_ACTIVE_SKILL.1.def"));
    mod.dispatch.addDefinition("C_START_SERVANT_ACTIVE_SKILL", 2, path.join(__dirname, "defs", "C_START_SERVANT_ACTIVE_SKILL.2.def"));
    mod.dispatch.addDefinition("S_START_COOLTIME_SERVANT_SKILL", 1, path.join(__dirname, "defs", "S_START_COOLTIME_SERVANT_SKILL.1.def"));
    mod.dispatch.addDefinition("S_UPDATE_SERVANT_INFO", 1, path.join(__dirname, "defs", "S_UPDATE_SERVANT_INFO.1.def"));

    mod.game.initialize(['me', 'me.abnormalities', 'inventory', 'contract']);

    let characterId = null;
    let playerLoc = null;
    let playerW = null;
    let petGameId = null;
    let petSummoned = false;
    let newServant = null;
    let mainServant = null;    
    let petSummonInterval = null;
    let petSkillCooldown = false;
    let firstSummon = false;
    let buffCheckTimeout = null;

    const BUFFS_FOOD = [    
        70233, // Fish Fritters    
    ];
    
    function abnormalityDuration(id) {
        const abnormality = mod.game.me.abnormalities[id];        
        return abnormality ? abnormality.remaining : 0n;
    }

    mod.command.add("pet", {
        save: () => {
            if (newServant) {
                saveServant();
            } else {
                mod.command.message("You must summon a pet first before you can save it.");
            }
        },
        feed: arg => {
            const n = Number(arg);
            if (isNaN(n) || n >= 100 || n < 0) {
                mod.command.message("Pet Stamina % must be set between 1 and 99.");
            } else {
                mod.settings.feedWhenBelow = n;
                mod.command.message(`Auto feed is now set to <font color="#5da8ce">${n}%</font>`);
            }
        },
        on: () => {
            mod.settings.characters[characterId].enabled = true;
            mod.command.message(`Module <font color="#00FF00">Enabled</font> for <font color="#00BFFF">${mod.settings.characters[characterId].name}</font>`);
        },
        off: () => {
            mod.settings.characters[characterId].enabled = false;
            mod.command.message(`Module <font color="#FF0000">Disabled</font> for <font color="#00BFFF">${mod.settings.characters[characterId].name}</font>`);
        },
        summon: () => {
            summonPet();
        },
        $none: () => {
            mod.settings.enabled = !mod.settings.enabled;
            mod.command.message(`Auto Pet is now ${mod.settings.enabled ? "<font color=\"#5dce6a\">Enabled</font>" : "<font color=\"#dc4141\">Disabled</font>"}.`);
        },
        debug: () => {
            mod.command.message(`Debug: petSummoned=${petSummoned}, alive=${mod.game.me.alive}, bondSkill=${mod.settings.characters[characterId]?.bondSkill || 'null'}, cooldown=${petSkillCooldown}, buffActive=${BUFFS_FOOD.some(buff => abnormalityDuration(buff) > 0n)}`);
        }
    });

    mod.hook("S_LOGIN", 14, event => {
        characterId = `${event.playerId}_${event.serverId}`;
        if (mod.settings.characters[characterId] === undefined) {
            mod.settings.characters[characterId] = {
                name: event.name,
                enabled: true,
                bondSkill: null
            };
        }        
        if (mod.settings.enabled && mod.settings.characters[characterId].enabled && petSummoned && mod.settings.characters[characterId].bondSkill) {
            usePetSkill();
        }
    });

    mod.hook("S_USER_CHANGE_NAME", 1, event => {
        if (mod.game.me.is(event.gameId)) {
            if (mod.settings.characters[characterId] !== undefined) {
                mod.settings.characters[characterId].name = event.name;
            }
        }
    });

    mod.hook("C_PLAYER_LOCATION", 5, event => {
        playerLoc = event.loc;
        playerW = event.w;
    });

    mod.hook("S_REQUEST_DESPAWN_SERVANT", 1, event => {
        if (event.gameId === petGameId) {
            petSummoned = false;
            petGameId = null;
            newServant = null;
            if (event.despawnType === 0) {
                firstSummon = true;
            }
            if (buffCheckTimeout) {
                mod.clearTimeout(buffCheckTimeout);
                buffCheckTimeout = null;
            }
        }
    });

    mod.hook("S_REQUEST_SPAWN_SERVANT", 4, event => {
        if (mod.game.me.is(event.ownerId)) {
            mod.clearInterval(petSummonInterval);
            firstSummon = false;
            newServant = new Servant(event);
            petSummoned = true;
            petGameId = event.gameId;
            const pet = mod.settings.characters[characterId];            
            if (mainServant == null || newServant.ID != mainServant.ID) {
                mod.command.message(`Use 'pet save' to save <font color="#30e785">"${event.name}"</font> as your default pet`);
            }
            if (mod.settings.enabled && pet && pet.enabled && pet.bondSkill) {
                startBuffCheck();
            }
        }
    });

    mod.hook("C_START_SERVANT_ACTIVE_SKILL", mod.majorPatchVersion >= 100 ? 2 : 1, { filter: { fake: null } }, event => {
        mod.settings.characters[characterId].bondSkill = event.skill;        
    });   

    mod.game.on("enter_game", () => {
        firstSummon = true;
    });

    mod.game.on("leave_game", () => {
        firstSummon = false;
        if (buffCheckTimeout) {
            mod.clearTimeout(buffCheckTimeout);
            buffCheckTimeout = null;
        }
    });

    mod.game.me.on("resurrect", () => {
        const pet = mod.settings.characters[characterId];        
        if (mod.settings.enabled && pet && pet.enabled && pet.bondSkill && petSummoned) {
            mod.setTimeout(() => {
                usePetSkill();
            }, 3000);
        }
    });

    mod.hook("S_UPDATE_SERVANT_INFO", 1, event => {
        if (mainServant && event.dbid == mainServant.UniqueID) {
            const energy = (event.energy / 300) * 100;
            if (mod.settings.enabled && petSummoned && !mod.game.me.inCombat && energy <= mod.settings.feedWhenBelow) {
                feedPet();
            }
        }
    });

    mod.hook("S_VISIT_NEW_SECTION", 1, () => {
        if (mod.settings.enabled && firstSummon) {
            summonPet();
        }
    });

    function summonPet() {
        const key = `${mod.game.me.serverId}_${mod.game.me.playerId}`;
        const playerPet = mod.settings.servantsList[key];
        if (playerPet != undefined) {
            mainServant = new Servant(playerPet);
        }
        if (mainServant && !petSummoned && mod.settings.enabled) {
            mod.clearInterval(petSummonInterval);
            petSummonInterval = mod.setInterval(() => {
                mod.send("C_REQUEST_SPAWN_SERVANT", mod.majorPatchVersion >= 100 ? 2 : 1, {
                    servantId: mainServant.ID,
                    uniqueId: mainServant.UniqueID,
                    unk: 0
                });
            }, 1500);
        }
    }

    function usePetSkill() {                
        mod.send("C_START_SERVANT_ACTIVE_SKILL", mod.majorPatchVersion >= 100 ? 2 : 1, {
            gameId: petGameId,
            skill: mod.settings.characters[characterId].bondSkill
        });
    }

    function saveServant() {
        const key = `${mod.game.me.serverId}_${mod.game.me.playerId}`;
        mod.settings.servantsList[key] = newServant.stringify();
        mod.command.message(`Saved <font color="#30e785">"${newServant.Name}"</font> as your default pet."`);
        mainServant = newServant;
    }

    function feedPet() {
        const foods = mod.settings.petFood;
        let foodFound = false;
        foods.forEach(item => {
            const foodItem = mod.game.inventory.findInBagOrPockets(item.id);
            if (foodItem) {
                foodFound = true;
                mod.send("C_USE_ITEM", 3, {
                    gameId: mod.game.me.gameId,
                    id: foodItem.id,
                    dbid: foodItem.dbid,
                    target: 0,
                    amount: 1,
                    dest: 0,
                    loc: playerLoc,
                    w: playerW,
                    unk1: 0,
                    unk2: 0,
                    unk3: 0,
                    unk4: true
                });
                return;
            }
        });
        if (!foodFound) {
            mod.command.message("You don't have any pet food in inventory!");
        }        
    }

    function startBuffCheck() {
        if (buffCheckTimeout) {
            mod.clearTimeout(buffCheckTimeout);
        }
        buffCheckTimeout = mod.setTimeout(() => {
            if (mod.settings.enabled && mod.settings.characters[characterId]?.enabled && petSummoned) {
                const buffRemaining = BUFFS_FOOD.some(buff => {
                    const remaining = abnormalityDuration(buff);
                    return remaining > 0n && remaining <= BigInt(60 * 1000);
                });
                const buffEnded = BUFFS_FOOD.every(buff => abnormalityDuration(buff) === 0n);
                if (buffRemaining || buffEnded) {                    
                    usePetSkill();
                }
                if (petSummoned) {
                    startBuffCheck(); 
                }
            }
        }, 10000); 
    }
};