import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

const row = new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
    .setCustomId('select_loc_origin')
    .setPlaceholder('Chọn điểm đi...')
    .addOptions([{label: 'A', value: '1'}, {label: 'B', value: '2'}])
);

const rowJson = row.toJSON();
// mock what we receive from message.components
const receivedRow = rowJson; 

const builderRow = ActionRowBuilder.from(receivedRow);
const select = builderRow.components[0];
console.log(select.options);
