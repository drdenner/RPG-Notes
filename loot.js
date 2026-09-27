// loot.js
// Rolls random magic items on the SRD 3.5 tables in
// data/srd35-magic-items.js, the way the rules describe it: first the
// kind of item (armor, potion, wand, ...), then as many further tables as
// that kind needs (armor type, special abilities, a bane weapon's foe, the
// spells on a scroll, ...). No DOM here - loot-view.js shows the results.
//
// Every roll returns an item:
//   { name, price (gp, or null if the tables don't give one), tier,
//     category, rolls: ["Table title: d% 37 → result", ...] }
// `rolls` lists every die rolled on the way, so you can see (and check)
// how the item came about.

const Loot = (() => {
  const TIERS = ['minor', 'medium', 'major'];

  // what can be rolled, in the order the buttons show them; rods and
  // staffs don't exist as minor items
  const CATEGORIES = [
    { id: 'armor', label: 'Armor & shields', roll: rollArmorOrShield },
    { id: 'weapon', label: 'Weapons', roll: rollWeapon },
    { id: 'potion', label: 'Potions', roll: rollPotion },
    { id: 'ring', label: 'Rings', roll: rollRing },
    { id: 'rod', label: 'Rods', roll: rollRod, noMinor: true },
    { id: 'scroll', label: 'Scrolls', roll: rollScroll },
    { id: 'staff', label: 'Staffs', roll: rollStaff, noMinor: true },
    { id: 'wand', label: 'Wands', roll: rollWand },
    { id: 'wondrous', label: 'Wondrous items', roll: rollWondrous }
  ];
  // the rows of "Random Magic Item Generation", in table order
  const ITEM_TABLE_CATEGORIES = ['armor', 'weapon', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand', 'wondrous'];

  // --- the tables, with their "12-20" ranges turned into numbers ---

  function parseRange(text) {
    if (!text) return null;
    const [lo, hi] = text.split('-').map(Number);
    return [lo, hi === undefined ? lo : hi];
  }

  const tables = {};
  Object.entries(SRD35_ITEMS).forEach(([id, t]) => {
    tables[id] = {
      id,
      title: t.title,
      tiered: t.tiered,
      rows: t.rows.map(r => {
        const ranges = t.tiered
          ? { minor: parseRange(r[0]), medium: parseRange(r[1]), major: parseRange(r[2]) }
          : { d: parseRange(r[0]) };
        const rest = r.slice(t.tiered ? 3 : 1);
        const price = rest[1];
        return {
          ranges,
          name: rest[0],
          price: typeof price === 'number' ? price : null,
          bonus: typeof price === 'string' ? Number(price) : 0, // "+2" special abilities
          extra: rest.slice(2) // scroll spell levels: [spell level, caster level]
        };
      })
    };
  });

  // --- dice ---

  function d(sides) {
    return 1 + Math.floor(Math.random() * sides);
  }

  // one d% roll on a table (the tier's column for tiered tables);
  // written down in `rolls`
  function roll(tableId, tier, rolls) {
    const table = tables[tableId];
    const column = table.tiered ? tier : 'd';
    const n = d(100);
    const row = table.rows.find(r => r.ranges[column] && n >= r.ranges[column][0] && n <= r.ranges[column][1]);
    rolls.push(`${table.title}${table.tiered ? ' (' + tier + ')' : ''}: d% ${n} → ${row.name}`);
    return row;
  }

  function pick(list, what, rolls) {
    const choice = list[d(list.length) - 1];
    rolls.push(`${what}: ${choice}`);
    return choice;
  }

  // --- names ---

  // "Sword, bastard" → "bastard sword", "Shield, light, wooden" → "light
  // wooden shield", "Arrows (50)" stays as it is
  function naturalName(name) {
    const m = name.match(/^(.*?)(\s*\(.*\))?$/);
    const parts = m[1].split(', ');
    const words = parts.length > 1 ? [...parts.slice(1), parts[0]].join(' ') : parts[0];
    return words.toLowerCase() + (m[2] || '');
  }

  function lowerFirst(s) {
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  function upperFirst(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // "+1 flaming longsword" with one plain special ability; with more, or
  // one with a number or foe in it, they're listed after the item so the
  // name stays readable: "+3 breastplate (spell resistance 15)",
  // "+4 rapier (holy, shocking burst, bane: undead)"
  function magicName(enhancement, abilities, base) {
    const labels = abilities.map(a => a.label);
    if (!labels.length) return `+${enhancement} ${base}`;
    if (labels.length === 1 && !/[\d:]/.test(labels[0])) return `+${enhancement} ${labels[0]} ${base}`;
    return `+${enhancement} ${base} (${labels.join(', ')})`;
  }

  // --- armor and shields ---

  // how an armor/shield/weapon special ability relates to others: two of
  // the same family keep only the better one (armor) or are rerolled
  // (weapons); opposites can't be on the same weapon
  function abilityFamily(name) {
    return name
      .replace(/ burst$/, '')
      .replace(/^Icy$/, 'Frost')
      .replace(/^Shocking$/, 'Shock')
      .replace(/,.*$/, '')
      .replace(/ \(\d+\)$/, '');
  }
  const OPPOSITES = { Holy: 'Unholy', Unholy: 'Holy', Anarchic: 'Axiomatic', Axiomatic: 'Anarchic' };

  // what a special ability adds to the price: "+2" ones raise the
  // effective bonus, the others cost a fixed number of gp
  function abilityWorth(row) {
    return row.bonus ? row.bonus * 1e6 : row.price || 0;
  }

  // rolls `count` special abilities; "Roll twice again" turns one roll
  // into two. An item's enhancement bonus plus its "+N" abilities can't
  // be more than +10.
  //  - armor/shields: rolling an ability twice, or a lesser version of one
  //    it already has, just doesn't count (the better one stays)
  //  - weapons: duplicates, incompatible abilities, abilities the weapon
  //    can't have (see `allowed`) and ones that go over +10 are rerolled
  function rollAbilities(tableId, tier, count, enhancement, rolls, { reroll, allowed = () => true }) {
    const chosen = [];
    let pending = count;
    let attempts = 0;
    while (pending > 0 && attempts++ < 50) {
      const row = roll(tableId, tier, rolls);
      if (row.name.startsWith('Roll')) { pending += 1; continue; } // this roll becomes two
      const family = abilityFamily(row.name);
      const same = chosen.find(a => abilityFamily(a.row.name) === family);
      const opposite = chosen.some(a => a.row.name === OPPOSITES[row.name]);
      const bonusTotal = enhancement + chosen.filter(a => a !== same).reduce((sum, a) => sum + a.row.bonus, 0) + row.bonus;
      const problem = !allowed(row) ? 'not possible on this item'
        : same && reroll ? 'already has ' + same.label
        : opposite ? 'incompatible'
        : bonusTotal > 10 ? 'over the +10 limit'
        : null;
      if (problem) {
        rolls.push(`  ${reroll ? 'rerolled' : 'ignored'}: ${problem}`);
        if (reroll) continue;
        pending--;
        continue;
      }
      pending--;
      if (same) {
        if (abilityWorth(row) <= abilityWorth(same.row)) {
          rolls.push(`  ignored: already has ${same.label}`);
          continue;
        }
        chosen.splice(chosen.indexOf(same), 1);
      }
      // "Spell resistance (13)" → "spell resistance 13"
      const ability = { row, label: naturalName(row.name).replace(/ \((\d+)\)$/, ' $1') };
      if (row.name === 'Bane') {
        ability.label = `bane: ${lowerFirst(roll('baneFoe', null, rolls).name)}`;
      }
      chosen.push(ability);
    }
    return chosen;
  }

  // "Special ability and roll again": each one means one more special
  // ability, and the table is rolled again for the item itself (until it
  // gives a +N result - a specific item can't take extra abilities)
  function rollEnhanced(tableId, tier, rolls) {
    let abilities = 0;
    for (;;) {
      const row = roll(tableId, tier, rolls);
      if (row.name.startsWith('Special ability')) { abilities++; continue; }
      if (row.name.startsWith('Specific') && abilities) {
        rolls.push('  rolled again: a specific item can\'t take the special ability');
        continue;
      }
      return { row, abilities };
    }
  }

  function rollArmorOrShield(tier) {
    const rolls = [];
    const { row, abilities } = rollEnhanced('armorShield', tier, rolls);
    if (row.name === 'Specific armor' || row.name === 'Specific shield') {
      const specific = roll(row.name === 'Specific armor' ? 'specificArmor' : 'specificShield', tier, rolls);
      return { name: specific.name, price: specific.price, rolls };
    }
    const [, enhancementText, kind] = row.name.match(/^\+(\d+) (armor|shield)/);
    const enhancement = Number(enhancementText);
    const type = roll(kind === 'armor' ? 'armorType' : 'shieldType', null, rolls);
    const chosen = rollAbilities(kind === 'armor' ? 'armorAbility' : 'shieldAbility', tier, abilities, enhancement, rolls, { reroll: false });
    const bonus = enhancement + chosen.reduce((sum, a) => sum + a.row.bonus, 0);
    const price = bonus * bonus * 1000 + chosen.reduce((sum, a) => sum + (a.row.price || 0), 0) + type.price;
    return { name: magicName(enhancement, chosen, naturalName(type.name)), price, rolls };
  }

  // --- weapons ---

  // damage types, for the abilities only some weapons can have (keen:
  // piercing or slashing, disruption: bludgeoning, vorpal: slashing)
  const DAMAGE = {
    'Dagger': 'PS', 'Greataxe': 'S', 'Greatsword': 'S', 'Kama': 'S', 'Longsword': 'S',
    'Mace, light': 'B', 'Mace, heavy': 'B', 'Nunchaku': 'B', 'Quarterstaff': 'B', 'Rapier': 'P',
    'Scimitar': 'S', 'Shortspear': 'P', 'Siangham': 'P', 'Sword, bastard': 'S', 'Sword, short': 'P',
    'Waraxe, dwarven': 'S', 'Axe, orc double': 'S', 'Battleaxe': 'S', 'Chain, spiked': 'P', 'Club': 'B',
    'Dagger, punching': 'P', 'Falchion': 'S', 'Flail, dire': 'B', 'Flail, heavy': 'B', 'Flail': 'B',
    'Gauntlet': 'B', 'Gauntlet, spiked': 'P', 'Glaive': 'S', 'Greatclub': 'B', 'Guisarme': 'S',
    'Halberd': 'PS', 'Spear': 'P', 'Hammer, gnome hooked': 'BP', 'Hammer, light': 'B', 'Handaxe': 'S',
    'Kukri': 'S', 'Lance': 'P', 'Longspear': 'P', 'Morningstar': 'BP', 'Pick, heavy': 'P',
    'Pick, light': 'P', 'Ranseur': 'P', 'Sap': 'B', 'Scythe': 'PS', 'Sickle': 'S',
    'Sword, two-bladed': 'S', 'Trident': 'P', 'Urgrosh, dwarven': 'PS', 'Warhammer': 'B', 'Whip': 'S'
  };
  // the ranged weapons among the uncommon ones, and the ones that are thrown
  // (only those can be "returning")
  const UNCOMMON_RANGED = ['Crossbow, hand', 'Crossbow, repeating', 'Shuriken (50)', 'Net'];
  const THROWN = ['Axe, throwing', 'Dart', 'Javelin', 'Shuriken (50)', 'Net'];
  // both ends can be enchanted
  const DOUBLE = ['Quarterstaff', 'Axe, orc double', 'Flail, dire', 'Hammer, gnome hooked', 'Sword, two-bladed', 'Urgrosh, dwarven'];

  function weaponAllows(weaponName) {
    const damage = DAMAGE[weaponName] || '';
    return row => {
      if (row.name === 'Keen') return /[PS]/.test(damage);
      if (row.name === 'Disruption') return damage.includes('B');
      if (row.name === 'Vorpal') return damage.includes('S');
      if (row.name === 'Returning') return THROWN.includes(weaponName);
      return true;
    };
  }

  function rollWeapon(tier) {
    const rolls = [];
    const { row, abilities } = rollEnhanced('weapon', tier, rolls);
    if (row.name === 'Specific weapon') {
      const specific = roll('specificWeapon', tier, rolls);
      let name = specific.name;
      if (name.startsWith('Slaying arrow')) name += ` (${lowerFirst(roll('baneFoe', null, rolls).name)})`;
      return { name, price: specific.price, rolls };
    }
    const enhancement = Number(row.name.slice(1));
    const typeRow = roll('weaponType', null, rolls);
    const typeTable = { 'Common melee weapon': 'commonMelee', 'Uncommon weapon': 'uncommonWeapon', 'Common ranged weapon': 'commonRanged' }[typeRow.name];
    let weapon = roll(typeTable, null, rolls);
    if (weapon.name.startsWith('Ammunition')) weapon = roll('ammunition', null, rolls);
    const ranged = typeTable === 'commonRanged' || UNCOMMON_RANGED.includes(weapon.name);
    const chosen = rollAbilities(ranged ? 'rangedAbility' : 'meleeAbility', tier, abilities, enhancement, rolls,
      { reroll: true, allowed: weaponAllows(weapon.name) });
    const bonus = enhancement + chosen.reduce((sum, a) => sum + a.row.bonus, 0);
    let price = bonus * bonus * 2000 + weapon.price;
    let name = magicName(enhancement, chosen, naturalName(weapon.name));

    // a double weapon's other end: the same enhancement bonus (01-50), or
    // one less and no special abilities
    if (DOUBLE.includes(weapon.name)) {
      const n = d(100);
      const other = n <= 50 ? enhancement : enhancement - 1;
      rolls.push(`Other end of the double weapon: d% ${n} → ${other > 0 ? '+' + other : 'no enhancement'}`);
      price += other * other * 2000;
      name = name.replace(/^\+\d+/, `+${enhancement}/+${other}`);
    }
    return { name, price, rolls };
  }

  // --- potions, rings, rods, staffs, wands, wondrous items ---

  const ENERGY = ['acid', 'cold', 'electricity', 'fire', 'sonic'];
  const ALIGNMENTS = ['chaos', 'evil', 'good', 'law'];

  function rollPotion(tier) {
    const rolls = [];
    const row = roll('potion', tier, rolls);
    // "Cure light wounds (potion)" → "Potion of cure light wounds"
    const m = row.name.match(/^(.*) \((potion|oil|potion or oil)\)$/);
    let name = m ? `${m[2] === 'oil' ? 'Oil' : 'Potion'} of ${lowerFirst(m[1])}` : row.name;
    name = name
      .replace('(type)', () => '(' + pick(ENERGY, 'Energy type', rolls) + ')')
      .replace('(alignment)', () => pick(ALIGNMENTS, 'Alignment', rolls));
    return { name, price: row.price, rolls };
  }

  function simple(tableId, prefix, nameOf) {
    return tier => {
      const rolls = [];
      const row = roll(tableId, tier, rolls);
      return { name: nameOf ? nameOf(row.name) : `${prefix} of ${lowerFirst(row.name)}`, price: row.price, rolls };
    };
  }

  function rollRing(tier) { return simple('ring', 'Ring')(tier); }
  function rollStaff(tier) { return simple('staff', 'Staff')(tier); }
  function rollWand(tier) { return simple('wand', 'Wand')(tier); }
  function rollWondrous(tier) { return simple('wondrous' + upperFirst(tier), null, n => n)(tier); }

  // "Metamagic, Enlarge, lesser" → "Lesser metamagic rod (Enlarge)",
  // "Immovable" → "Immovable rod", "Wonder" → "Rod of wonder"
  function rodName(name) {
    const meta = name.match(/^Metamagic, ([^,]+)(?:, (\w+))?$/);
    if (meta) return `${meta[2] ? upperFirst(meta[2]) + ' metamagic' : 'Metamagic'} rod (${meta[1]})`;
    if (name === 'Immovable') return 'Immovable rod';
    return 'Rod of ' + lowerFirst(name);
  }
  function rollRod(tier) { return simple('rod', null, rodName)(tier); }

  // --- scrolls ---

  // arcane or divine; minor/medium/major scrolls hold 1d3/1d4/1d6 spells
  const SCROLL_SPELL_DICE = { minor: 3, medium: 4, major: 6 };

  function rollScroll(tier) {
    const rolls = [];
    const type = roll('scrollType', null, rolls).name.toLowerCase(); // arcane / divine
    const count = d(SCROLL_SPELL_DICE[tier]);
    rolls.push(`Number of spells: 1d${SCROLL_SPELL_DICE[tier]} → ${count}`);
    const spells = [];
    let price = 0;
    for (let i = 0; i < count; i++) {
      const level = roll('scrollLevel', tier, rolls);
      const [spellLevel, casterLevel] = level.extra;
      const spell = roll(`${type}Scroll${spellLevel}`, null, rolls);
      spells.push(`${spell.name} (${level.name === '0' ? 'level 0' : level.name}, CL ${casterLevel})`);
      price += spell.price;
    }
    return { name: `${upperFirst(type)} scroll: ${spells.join(', ')}`, price, rolls };
  }

  // --- rolling ---

  function categoryById(id) {
    return CATEGORIES.find(c => c.id === id);
  }

  function isAvailable(categoryId, tier) {
    const category = categoryById(categoryId);
    return !!category && !(category.noMinor && tier === 'minor');
  }

  // categoryId 'any': first "Random Magic Item Generation" decides what it is
  function rollItem(categoryId, tier) {
    let firstRolls = [];
    if (categoryId === 'any') {
      const row = roll('item', tier, firstRolls);
      categoryId = ITEM_TABLE_CATEGORIES[tables.item.rows.indexOf(row)];
    }
    const category = categoryById(categoryId);
    const item = category.roll(tier);
    return {
      name: item.name,
      price: item.price == null ? null : item.price,
      tier,
      category: categoryId,
      rolls: [...firstRolls, ...item.rolls]
    };
  }

  // 1234.5 → "1,234 gp 5 sp"
  function formatPrice(gp) {
    if (gp == null) return '';
    const whole = Math.floor(gp);
    const sp = Math.round((gp - whole) * 10);
    return whole.toLocaleString('en-US') + ' gp' + (sp ? ` ${sp} sp` : '');
  }

  return { TIERS, CATEGORIES, tables, rollItem, isAvailable, formatPrice };
})();
