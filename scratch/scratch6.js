import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

const menu = new StringSelectMenuBuilder()
  .setCustomId('test')
  .addOptions([
    { label: 'A', value: '1' },
    { label: 'B', value: '2' }
  ]);
const row = new ActionRowBuilder().addComponents(menu);

const rawRow = row.toJSON();

const newRow = ActionRowBuilder.from(rawRow);
const select = newRow.components[0];
try {
  select.setOptions(
    select.options.map(opt => ({
      ...opt.data,
      default: opt.data.value === '1'
    }))
  );
  console.log(JSON.stringify(newRow.toJSON(), null, 2));
} catch (e) {
  console.error(e);
}
