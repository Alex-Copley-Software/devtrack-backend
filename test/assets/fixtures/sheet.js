// A small stand-in for the real sheet, shaped the way the Sheets API returns
// it: title row, description row, blank row, headers on row 4, data from
// row 5 (Lists and Dev Lists have headers on row 1). Computed columns are
// included so the parser has to ignore them, and a few rows are
// deliberately bad.

const preamble = title => [[title], ['Description of this tab'], []];

module.exports = {
  updates: [
    ...preamble('Updates'),
    ['Update #', 'Update Name', 'Status', 'Target Release', 'Lead', 'Items', 'Tasks', 'Done', 'Progress', 'Summary / Notes'],
    [4, 'Bleach', 'In Development', 46327, 'MrBee', 2, 5, 1, 0.2, 'https://www.notion.so/ae/Bleach-abc123'],
    [5, 'Naruto', 'planning', '', 'Somebody Else', 0, 0, 0, 0, 'Early ideas only'],
    [6, 'Broken', 'On Fire', '', '', 0, 0, 0, 0, ''],
  ],
  items: [
    ...preamble('Update Content'),
    ['#', 'Update #', 'Content Type', 'Display Name', 'Internal Name (ID)', 'Owner', 'Priority', 'Template Tasks', 'Active Tasks', 'Done', 'Progress', 'Blocked', 'Description / Notes'],
    [1, 4, 'Unit', 'Secret', 'Ulquiorra', 'Ani', 'Medium', 3, 3, 0, 0, 0, 'Second form later'],
    [2, 4, 'Unit', 'Mythic', 'Aizen', '', 'High', 3, 3, 1, 0.33, 0, 'https://www.notion.so/ae/Aizen-def456'],
    [3, 4, 'Boss', 'Raid boss', 'Yhwach', 'Ghost', 'Low', 2, 2, 0, 0, 0, ''],
    [4, 4, 'Vehicle', 'Car', 'Car', '', 'Low', 0, 0, 0, 0, 0, ''],
    [5, 9, 'Unit', 'Orphan', 'Orphan', '', 'Low', 0, 0, 0, 0, 0, ''],
  ],
  templates: [
    ...preamble('Templates'),
    ['Content Type', 'Task #', 'Discipline', 'Deliverable', 'Definition of Done', 'Required', 'Task ID'],
    ['Unit', 1, 'Design', 'Unit design brief', 'Kit, role, rarity, element, archetype, attack type and placement type locked', 'Yes', 'T0001'],
    ['Unit', 2, 'Animation', 'Attack animations', 'All attacks animated and exported', 'Yes', 'T0002'],
    ['Unit', 3, 'VFX', 'Ability VFX', 'VFX approved in game', 'No', 'T0003'],
    ['Boss', 1, 'Design', 'Boss design brief', 'Phases and attacks locked', 'Yes', 'T0010'],
    ['Boss', 2, 'Builder', 'Arena', 'Arena built and lit', 'Yes', 'T0011'],
    ['Boss', 3, 'Cooking', 'Lunch', '', 'Yes', 'T0012'],
  ],
  tasks: [
    ...preamble('Task Tracker'),
    ['Update #', 'Content Type', 'Content', 'Internal Name', '#', 'Discipline', 'Deliverable', 'Required', 'Assigned To', 'Status', 'Due Date', 'Notes / Asset ID', 'Dev Opt 1', 'Item #', 'Task ID'],
    [4, 'Unit', 'Secret', 'Ulquiorra', 1, 'Design', 'Unit design brief', 'Yes', 'MrBee', 'Done', '', '', 'MrBee', 1, 'T0001'],
    [4, 'Unit', 'Secret', 'Ulquiorra', 2, 'Animation', 'Attack animations', 'Yes', 'Ani', 'In Progress', 46335, 'rbxassetid://123', 'Ani', 1, 'T0002'],
    [4, 'Unit', 'Secret', 'Ulquiorra', 3, 'VFX', 'Ability VFX', 'No', '', 'Not Started', '', '', '', 1, 'T0003'],
    [4, 'Unit', 'Mythic', 'Aizen', 1, 'Design', 'Unit design brief', 'Yes', 'Nobody', 'Review', '11/20/2026', '', '', 2, 'T0001'],
    [4, 'Unit', 'Mythic', 'Aizen', 2, 'Animation', 'Attack animations', 'Yes', 'Ani', 'Almost', '', '', '', 2, 'T0002'],
    [4, 'Boss', 'Raid boss', 'Yhwach', 1, 'Design', 'Boss design brief', 'Yes', '', 'Blocked', '', 'Waiting on lore', '', 3, 'T0010'],
    [4, 'Boss', 'Raid boss', 'Yhwach', 9, 'Design', 'Mystery', 'Yes', '', 'Done', '', '', '', 3, 'T0999'],
    [4, 'Unit', 'Gone', 'Gone', 1, 'Design', 'Unit design brief', 'Yes', '', 'Done', '', '', '', 77, 'T0001'],
  ],
  devs: [
    ...preamble('Devs'),
    ['Name', 'Discipline', 'Secondary Discipline', 'Status', 'Discord Profile Link', 'Open Tasks', 'Done Tasks', 'Workload', 'Dev Notes'],
    ['MrBee', 'Manager', 'Design', 'Active', 'https://discord.com/users/111111111111111111', 0, 1, '', 'Lead'],
    ['Ani', 'Animation', '', 'On Break', 'https://discordapp.com/users/222222222222222222', 1, 0, '', ''],
    ['Vex', 'VFX', 'Juggling', 'Retired', 'no link yet', 0, 0, '', ''],
  ],
  lists: [
    ['Content Types', 'Task Status', 'Disciplines', 'Priority', 'Update Status', 'Dev Status'],
    ['Unit', 'Not Started', 'Design', 'High', 'Planning', 'Active'],
    ['Map / Stage', 'In Progress', 'Animation', 'Medium', 'In Development', 'On Break'],
    ['Boss', 'Review', 'VFX', 'Low', 'Testing', 'Inactive'],
    ['Skin', 'Done', 'Builder', '', 'Released', ''],
    ['', 'Blocked', 'Manager', '', 'Cancelled', ''],
    ['', 'N/A', 'Lighting', '', '', ''],
  ],
  devLists: [
    ['Design', 'Animation', 'VFX', 'Lighting'],
    ['MrBee', 'Ani', 'Vex', 'Vex'],
    ['Ani', '', 'Ani', 'Stranger'],
  ],
};
