import {
    ButtonComponent,
    Client,
    ComponentType,
    GatewayIntentBits,
    Message
} from 'discord.js'
import { v4 as uuidV4 } from 'uuid'
import fs from 'fs/promises'

interface MessageArchive {
    snowflake: string
    archiveId: string
    url: string
    stars: number
    textContent: string | undefined
    attachments: Array<{
        url: string
        localFile: string
    }>
}

const channelId = process.env['STARBOARD_CHANNEL_SNOWFLAKE'] ?? '' // channel id
const startingMessageId =
    process.env['STARBOARD_STARTING_MESSAGE_SNOWFLAKE'] ?? '' // first message id
// eslint-disable-next-line prettier/prettier
const starCountRegex = /⭐ \*\*(\d+)\*\*/ // regex to extract star count
const outDir = process.env['OUTPUT_DIR'] || './output' // output directory
const downloadsDir = process.env['DOWNLOADS_SUBDIR'] || 'downloads' // downloads directory within output directory
const perAttachmentDelay = parseInt(process.env['DOWNLOADS_DELAY_MS'] || '10') // delay between downloading attachments in ms

const messages = new Map<string, MessageArchive>()

;(async (): Promise<void> => {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent]
    })

    client.on('ready', async () => {
        console.log(`Logged in as ${client?.user?.tag}!`)

        if (
            await fs
                .access(`${outDir}/metadata.json`)
                .then(() => true)
                .catch(() => false)
        ) {
            const json = await fs.readFile(`${outDir}/metadata.json`, 'utf-8')
            const collection: MessageArchive[] = JSON.parse(json)
            for (const message of collection) {
                messages.set(message.snowflake, message)
            }
            console.log(`Loaded ${messages.size} messages from metadata.json`)
        } else {
            console.log('No metadata.json found')
            await fs.rm(outDir, { recursive: true }).catch(() => {})
            await fs.mkdir(`${outDir}/${downloadsDir}`, { recursive: true })
            console.log('Output directory created')
        }

        const channel = client.channels.cache.get(channelId)
        if (channel?.isTextBased()) {
            let messageId = startingMessageId

            console.log('Starting message collection')
            while (true) {
                const fetchedMessages = await channel.messages.fetch({
                    after: messageId,
                    limit: 100
                })

                if (fetchedMessages.size === 0) {
                    console.log('No more messages to fetch')
                    break
                }

                fetchedMessages.reverse()
                for (const message of fetchedMessages.values()) {
                    if (!isStarboardMessage(message)) continue
                    if (messages.has(message.id)) {
                        console.log(`[${message.id}] Skipping..`)
                        continue
                    }

                    console.log(`[${message.id}] Processing..`)
                    const processed = await processMessage(message)
                    messages.set(message.id, processed)
                    console.log(
                        `[${message.id}] Added to collection (${messages.size} total)`
                    )
                }

                const lastKey = fetchedMessages.lastKey()
                console.log('Last key:', lastKey)
                if (!lastKey) break
                messageId = lastKey

                console.log(`Stepper message id: ${messageId}`)
            }

            await saveMessageCollection()
        }
        process.exit(0)
    })

    client.login(process.env['DISCORD_TOKEN'])
})()

const isStarboardMessage = (message: Message): boolean => {
    return message.content.startsWith('⭐ **') && message.author.bot
}

const getStars = (message: Message): number => {
    // ⭐ **5**
    const match = message.content.match(starCountRegex)
    return match ? parseInt(match[1]) : 0
}

const getTextContent = (message: Message): string | undefined => {
    const embedDescriptions = message.embeds
        .map(embed => embed.description)
        .join('\n\n')
    return embedDescriptions.length > 0 ? embedDescriptions : undefined
}

const getAdvancedAttachments = async (message: Message): Promise<string[]> => {
    console.log(`[${message.id}] Getting advanced attachments..`)

    const messageLinks = message.components
        .flatMap(component => {
            if (component.type === ComponentType.ActionRow) {
                return component.components
                    .filter((component): component is ButtonComponent => {
                        return (
                            component.type === ComponentType.Button &&
                            'url' in component &&
                            typeof component.url === 'string' &&
                            component.url.startsWith(
                                'https://discord.com/channels'
                            )
                        )
                    })
                    .map(component => component.url)
            }
            return []
        })
        .filter((url): url is string => url !== null)

    let attachments: string[] = []
    try {
        const messages = await Promise.all(
            messageLinks.map(async link => {
                const splitLink = link.split('/')
                const channelId = splitLink[5]
                const messageId = splitLink[6]

                const channel = await message.client.channels.fetch(channelId)
                if (channel?.isTextBased()) {
                    const message = await channel.messages.fetch(messageId)
                    return message
                }
            })
        )

        attachments = (
            await Promise.all(
                messages.map(async message => {
                    if (message) {
                        return await getAttachmentUrls(message)
                    }
                })
            )
        )
            .filter(
                (attachments): attachments is string[] => attachments !== null
            )
            .flat()
    } catch (error) {
        console.error(
            `[${message.id}] Error fetching advanced attachments:`,
            error
        )
    }

    return attachments
}

const getAttachmentUrls = async (message: Message): Promise<string[]> => {
    const attachments =
        message.attachments.map(attachment => attachment.url) ?? []

    const embedImages =
        message.embeds
            .map(embed => embed.image?.url)
            .filter((url): url is string => url !== undefined) ?? []

    const embedVideos =
        message.embeds
            .map(embed => embed.video?.url)
            .filter((url): url is string => url !== undefined) ?? []

    let buttonLinks = message.components
        .flatMap(component => {
            if (component.type === ComponentType.ActionRow) {
                return component.components
                    .filter((component): component is ButtonComponent => {
                        return (
                            component.type === ComponentType.Button &&
                            'url' in component &&
                            typeof component.url === 'string' &&
                            !component.url.startsWith(
                                'https://discord.com/channels'
                            )
                        )
                    })
                    .map(component => component.url)
            }
            return []
        })
        .filter((url): url is string => url !== null)

    let advancedAttachments: string[] = []
    if (buttonLinks.length > 0) {
        if (
            buttonLinks.filter(
                url =>
                    url.startsWith('https://cdn.discordapp.com') ||
                    url.startsWith('https://media.discordapp.net')
            ).length > 0
        ) {
            // remove any advancedAttachments from buttonLinks
            buttonLinks = buttonLinks.filter(
                url =>
                    !url.startsWith('https://cdn.discordapp.com') &&
                    !url.startsWith('https://media.discordapp.net')
            )
            advancedAttachments = await getAdvancedAttachments(message)
        }
    }

    return [
        ...attachments,
        ...embedImages,
        ...embedVideos,
        ...buttonLinks,
        ...advancedAttachments
    ]
}

const getAttachments = async (
    message: Message,
    archiveId: string,
    stars: number
): Promise<MessageArchive['attachments']> => {
    const attachmentUrls = await getAttachmentUrls(message)

    const attachments: MessageArchive['attachments'] = []

    let attachmentNumber = 0
    for (const attachment of attachmentUrls) {
        console.log(`[${message.id}] Adding attachment ${attachmentNumber}..`)
        let ext = attachment.split('.').pop()?.split('?')[0]
        if (!ext) continue
        if (ext.endsWith(':large')) {
            ext = ext.slice(0, -6)
        }

        attachments.push({
            url: attachment,
            localFile: `${archiveId}_${stars}-stars_${attachmentNumber}.${ext}`
        })
        attachmentNumber++
    }

    return attachments
}

const saveTextContent = async (
    messageId: string,
    archiveId: string,
    stars: number,
    textContent: string | undefined
): Promise<void> => {
    if (textContent) {
        console.log(`[${messageId}] Saving text content..`)
        await fs.writeFile(
            `${outDir}/${downloadsDir}/${archiveId}_${stars}-stars_textcontent.txt`,
            textContent
        )
    }
}

const downloadAttachments = async (
    messageId: string,
    attachments: MessageArchive['attachments']
): Promise<void> => {
    let attachmentNumber = 0
    for (const attachment of attachments) {
        console.log(
            `[${messageId}] Downloading attachment ${attachmentNumber}..`
        )
        const response = await fetch(attachment.url)
        const fileData = await response.arrayBuffer()
        await fs.writeFile(
            `${outDir}/${downloadsDir}/${attachment.localFile}`,
            Buffer.from(fileData)
        )
        attachmentNumber++
        await new Promise(resolve => setTimeout(resolve, perAttachmentDelay))
    }
}

const processMessage = async (message: Message): Promise<MessageArchive> => {
    const archiveId = uuidV4()

    const stars = getStars(message)

    const textContent = getTextContent(message)
    await saveTextContent(message.id, archiveId, stars, textContent)

    const attachments = await getAttachments(message, archiveId, stars)
    await downloadAttachments(message.id, attachments)

    return {
        snowflake: message.id,
        archiveId,
        url: message.url,
        stars,
        textContent,
        attachments
    }
}

const saveMessageCollection = async (): Promise<void> => {
    console.log('Saving message collection..')
    const collection = [...messages.values()].sort(
        (a, b) => Number(a.snowflake) - Number(b.snowflake)
    )
    const json = JSON.stringify(collection, null, 2)
    await fs.writeFile(`${outDir}/metadata.json`, json)
}

process.on('SIGINT', async () => {
    await saveMessageCollection()
    process.exit(0)
})
