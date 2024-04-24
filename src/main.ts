import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';
import prism from 'prism-media';
import { GatewayIntentBits, Client, Partials, Message, VoiceBasedChannel, VoiceState, AttachmentBuilder } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, AudioReceiveStream, VoiceConnection, getVoiceConnection } from '@discordjs/voice';
import { SpeechClient } from '@google-cloud/speech';
import { arrayEqual, round, rmIfExistsSync } from './lib';

dotenv.config();

const directory = './audio';
rmIfExistsSync(directory, { recursive: true });
fs.mkdirSync(directory);

const speech = new SpeechClient();

const discord: Client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
});

discord.once('ready', () => {
  if (discord.user)
    console.log('ready as ' + discord.user.tag);
});

const userIdsSubscribed: Set<string> = new Set();

discord.on('voiceStateUpdate', (stateOld: VoiceState, stateNew: VoiceState) => {
  const channel: VoiceBasedChannel | null = stateOld?.channel || stateNew?.channel;

  // someone disconncted or moved
  if (stateOld.channel) {
    const { channel } = stateOld;
    // those who in the channel
    const ids: string[] = Array.from(channel!.members.values()).map(({ id }) => id);

    // when i am only member in the channel
    if (arrayEqual(ids, [discord.user?.id])) {
      console.log(`alone in server ${channel.guild.name} (${channel.guild.id}) channel ${channel.name} (${channel.id})`);

      //disconnect
      getVoiceConnection(channel.guild.id)?.destroy();
    }

    // when i am disconnected
    if (stateOld.id === discord.user?.id) {
      console.log(`disconnected from server ${channel.guild.name} (${channel.guild.id}) channel ${channel.name} (${channel.id})`);
      channel.send('disconnected');
      //rmIfExistsSync(directory, { recursive: true });
    }
  }

});

discord.on('messageCreate', async (message: Message) => {
  if (message.author.bot)
    return;

  if (discord.user && message.mentions.has(discord.user)) {
    const channelVoice = message.member?.voice?.channel;
    if (!channelVoice)
      return;

    transcribe(channelVoice);
  }
});

const transcribe = (channelVoice: VoiceBasedChannel) => {
  const time = new Date();

  const connection = joinVoiceChannel({
    channelId: channelVoice.id,
    guildId: channelVoice.guild.id,
    adapterCreator: channelVoice.guild.voiceAdapterCreator,
    selfMute: true,
    selfDeaf: false,
  });
  console.debug(`connected to server ${channelVoice.guild.name} (${channelVoice.guild.id}) channel ${channelVoice.name} (${channelVoice.id})`);
  channelVoice.send('connected');

  connection.receiver.speaking.on('start', (userId: string) => {
    if (userIdsSubscribed.has(userId) || !connection)
      return;

    userId

    if (discord.users.cache.get(userId)?.bot)
      return;

    const streamReceive: AudioReceiveStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    })
      .on('end', () => {
        userIdsSubscribed.delete(userId);
      })
      .on('error', (error: Error) => {
        userIdsSubscribed.delete(userId);
        console.error(`subscription erred: userId = ${userId}`, error);
      });

    userIdsSubscribed.add(userId);
    const file = `${directory}/${new Date().getTime()}-${userId}`;

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    const writer = streamReceive
      .pipe(decoder)
      .pipe(fs.createWriteStream(file + '.pcm'));

    writer.on('finish', async () => {
      const ffmpeg = exec(`ffmpeg -f s16le -ar 44.1k -ac 1 -i ${file}.pcm ${file}.flac`);

      const request = {
        config: {
          encoding: 'FLAC' as any,
          sampleRateHertz: 44100,
          languageCode: 'ja-JP',
        },
        interimResults: false,
      };

      const streamRecognize = speech
        .streamingRecognize(request)
        .on('error', console.error)
        .on('data', data => {
          try {
            const { transcript, confidence } = data.results[0].alternatives[0];
            //channelVoice.send(`<@${userId}> ${transcript}\`${round(confidence, 6).toString().slice(1)}\``);

            discord.users.fetch(userId).then(user => {
              const embed = {
                color: [0xFF0000, 0xFFA500, 0xFFFF00, 0xADFF2F, 0x00FF00][Math.floor(confidence * 5)],
                author: {
                  name: user.displayName,
                  url: 'https://discordapp.com/users/' + user.id,
                  icon_url: user.avatarURL() || ''
                },
                fields: [
                  //{ name: 'user', value: `<@${userId}>`, inline: true },
                  { name: 'transcript', value: transcript, inline: false },
                  { name: 'confidence', value: round(confidence, 3).toString().slice(1), inline: true },
                ],
                //files: [new AttachmentBuilder(file + '.flac')],
                footer: { text: time.toISOString() },
              };
              channelVoice.send({ embeds: [embed] });

              rmIfExistsSync(file + '.pcm');
              rmIfExistsSync(file + '.flac');
            });
          } catch (error) {
            console.error(error);
            if (error instanceof Error)
              channelVoice.send({
                embeds: [{
                  title: 'error',
                  color: 0x000000,
                  fields: [{ name: 'message', value: error.message }],
                }],
              });
          } finally {
            rmIfExistsSync(file + '.flac');
          }
        });

      ffmpeg.on("exit", async () => {
        rmIfExistsSync(file + '.pcm');

        try {
          fs.readFileSync(file + '.flac');
          fs.createReadStream(file + '.flac').pipe(streamRecognize);
        } catch (error) {
          if (error instanceof Error)
            console.error(error);
        }
      });
    });
  });
};

if (!process.env.DISCORD_TOKEN)
  throw 'set DISCORD_TOKEN';

discord.login(process.env.DISCORD_TOKEN);
