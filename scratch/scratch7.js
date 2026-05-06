import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

const menu = new StringSelectMenuBuilder()
  .setCustomId('select_origin_check')
  .setPlaceholder('Chọn điểm đi...')
  .addOptions([
    { label: 'A', value: '1' },
    { label: 'B', value: '2' }
  ]);
const row1 = new ActionRowBuilder().addComponents(menu);

const rawMessageComponents = [row1.toJSON()];

const value = '1';
const rowIdx = 0;
const newComponents = rawMessageComponents.map((row, index) => {
  const actionRow = ActionRowBuilder.from(row);
  if (index === rowIdx) {
    const select = actionRow.components[0];
    select.setOptions(
      select.options.map(opt => ({
        ...opt.data,
        default: opt.data.value === value
      }))
    );
  }
  return actionRow;
});

console.log(JSON.stringify(newComponents.map(c => c.toJSON()), null, 2));
