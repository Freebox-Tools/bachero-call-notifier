const { SlashCommandBuilder, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, codeBlock, spoiler } = require("discord.js")
const { FreeboxClient } = require("freebox-wrapper")
const escape = require("markdown-escape")
const fetch = require("node-fetch")
const bacheroFunctions = require("../../functions")
var botName = bacheroFunctions.config.getValue("bachero", "botName")
var botClient

// Cache
var cache
if(global.callNotifierCache) cache = global.callNotifierCache
else {
	const NodeCache = require("node-cache")
	cache = new NodeCache()
	global.callNotifierCache = cache
}

// Générer un embed
function generateEmbed(subtitle, description, color = "primary"){
	return new EmbedBuilder()
		.setTitle(`Freebox Call Notifier${subtitle ? ` — ${subtitle}` : ""}`)
		.setDescription(description)
		.setColor(bacheroFunctions.colors[color])
}

// Censurer une partie d'une chaîne de caractères
function censorString(string, completeReplace = false){
	if(!string?.length) return string
	if(typeof string != "string") string = string.toString()
	if(string.length < 8) return "*".repeat(string.length)
	return string.slice(0, 3) + "*".repeat(completeReplace ? (string.length - 6) : 10) + string.slice(-3) // On garde les 3 premiers et 3 derniers caractères, on remplace le reste par des étoiles
}

// Fonction pour vérifier si ON a accès à internet
async function checkInternet(){
	// On vérifie si on a accès à internet
	var response = await fetch("http://cloudflare.com", { // en théorie il devrait jamais down
		headers: { "User-Agent": "test" } // Cloudflare retourne la réponse plus vite
	}).catch(err => { return null })

	// Si on a pas de réponse, on retourne false
	if(!response) return false
	else return true
}
// Supabase
var { createClient } = require("@supabase/supabase-js")
var supabase = createClient(process.env.CALLNOTIFIER_SUPABASE_LINK, process.env.CALLNOTIFIER_SUPABASE_KEY)

// Obtenir le nom d'une Freebox
function getFreeboxName(name){
	if(name?.includes("Server Mini")) return "Mini 4K"
	if(name?.includes("Delta") || name?.includes("v7")) return "Delta"
	if(name?.includes("Pop") || name?.includes("v8")) return "Pop"
	if(name?.includes("Révolution") || name?.includes("Revolution") || name?.includes("v6")) return "Révolution"
	if(name?.includes("Server")) return "Server"
	return "Inconnue"
}

// Obtenir tout les utilisateurs
global.callNotifierFreeboxs = []
global.callNotifierUsers = [] // définir la variable globalement permet d'avoir la même donnée entre la commande texte et la commande slash
global.callNotifierSyncedOnce = false
async function getSupabaseUsers(){
	// On obtient les utilisateurs
	var { data, error } = await supabase.from("users").select("*").match({ platform: "discord" })
	if(error){
		bacheroFunctions.showLog("error", "Impossible de récupérer les utilisateurs via Supabase : ", "callnotifier-getusers")
		return bacheroFunctions.showLog("error", error, "callnotifier-getusers", true, true)
	}
	global.callNotifierUsers = data // on enregistre

	// On supprime les boxs déjà connectées qui n'existent plus
	global.callNotifierFreeboxs = global.callNotifierFreeboxs.filter(e => global.callNotifierUsers.find(f => f.userId == e.userId && f.id == e.id))

	// On s'authentifier sur toutes les boxs pas encore connectées
	for(const user of global.callNotifierUsers){
		// Si on a déjà cette box, on passe
		if(global.callNotifierFreeboxs.find(e => e.userId == user.userId && e.id == user.id)) continue

		// On initialise le client
		const freebox = new FreeboxClient({
			appId: user.appId,
			appToken: user.appToken,
			apiDomain: user.apiDomain,
			httpsPort: user.httpsPort
		})

		// On s'authentifie
		bacheroFunctions.showLog("info", `Connexion à la Freebox ${getFreeboxName(user.boxModel)} pour l'utilisateur ${user.userId}...`, "callnotifier-connection")
		var start = performance.now()
		var response = await freebox.authentificate()
		var injoignable = false
		if(!response?.success){
			bacheroFunctions.showLog("warn", `Impossible de se connecter à la Freebox ${getFreeboxName(user.boxModel)} pour l'utilisateur ${user.userId}(après ${Math.round(performance.now() - start)}ms) : `, "callnotifier-connection")
			bacheroFunctions.showLog("warn", response, "callnotifier-connection", true, true)

			// Injoignable
			injoignable = true

			// On prévient l'utilisateur
			if(!botClient) botClient = bacheroFunctions.botClient.get()
			botClient.users.fetch(user.userId).then(user => {
				user.send({ embeds: [generateEmbed("Échec de connexion", "Nous n'avons pas pu nous connecter à votre Freebox. Nous réessayerons plus tard. Si le problème persiste, veuillez vous déconnecter et vous reconnecter.", "secondary")] }).catch(err => {
					if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
					bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${user.userId} : `, "callnotifier-connection")
					bacheroFunctions.showLog("warn", err, "callnotifier-connection", true, true)
					return disconnectBox(user.userId, user.id)
				})
			}).catch(err => {
				if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
				bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${user.userId} : `, "callnotifier-connection")
				bacheroFunctions.showLog("warn", err, "callnotifier-connection", true, true)
				return disconnectBox(user.userId, user.id)
			})
		}
		else bacheroFunctions.showLog("ok", `Connecté à la Freebox ${getFreeboxName(user.boxModel)} pour l'utilisateur ${user.userId} en ${Math.round(performance.now() - start)}ms.`, "callnotifier-connection")

		// On ajoute la Freebox à la liste
		global.callNotifierFreeboxs.push({
			client: freebox,
			userId: user.userId,
			chatId: user.chatId,
			lastVoicemailId: user.lastVoicemailId,
			id: user.id,
			injoignable
		})

		// On attend 500ms avant de continuer
		await new Promise(r => setTimeout(r, 500))
	}

	// On retourne que c'est bon
	global.callNotifierSyncedOnce = true
	return true
}

// Fonction pour déconnecter la box d'un utilisateur
async function disconnectBox(userId, boxId){
	// Log
	bacheroFunctions.showLog("info", `Déconnexion de la box ${boxId || "Non spécifié(c'est normal tkt)"} pour l'utilisateur ${userId}.`, "callnotifier-disconnect")

	// On vérifie qu'on a accès à internet(parfois on pense que l'accès à la box a été révoqué mais on a juste pas de co)
	if(!await checkInternet()) return bacheroFunctions.showLog("warn", "Déconnexion annulée == On dirait que nous n'avons pas internet", "callnotifier-disconnect-checkinternet")

	// On supprime les infos de l'utilisateur
	var { error } = await supabase.from("users").delete().match({ userId: userId, platform: "discord" })
	if(error){
		if(boxId) var { error } = await supabase.from("users").delete().match({ id: boxId, platform: "discord" })
		if(error){
			bacheroFunctions.showLog("error", `Impossible de supprimer les données de l'utilisateur ${userId} : `, "callnotifier-disconnect-failed")
			bacheroFunctions.showLog("error", error, "callnotifier-disconnect-failed", true, true)
			return false
		}
	}

	// On supprime la box de la liste
	if(boxId) global.callNotifierFreeboxs = global.callNotifierFreeboxs.filter(e => e.userId != userId && e.id != boxId)
	else global.callNotifierFreeboxs = global.callNotifierFreeboxs.filter(e => e.userId != userId)

	// On retourne que c'est true
	return true
}

// Fonction pour activer le WPS sur la carte réseau d'une box
async function activateWPS(client, cardId, interaction){
	// On fait la requête
	var response = await client?.fetch({
		method: "POST",
		url: "/v9/wifi/wps/start/",
		body: JSON.stringify({ bssid: cardId }),
		parseJson: true
	})

	// On vérifie la réponse
	if(!response?.success) return interaction.editReply(response.error_code == "busy" ? "Une association est déjà en cours, patienter quelques minutes avant de réessayer." : (response?.msg || response?.message || "Impossible d'activer le WPS sur ce réseau.").replace("Cette application n'est pas autorisée à accéder à cette fonction", "Cette application n'est pas autorisée à accéder à cette fonction. [Comment autoriser l'activation du WPS ?](https://github.com/Freebox-Tools/telegram-call-notifier/wiki/Autoriser-l'activation-du-WPS)")).catch(err => {})

	// On génère l'embed
	var embed = new EmbedBuilder()
		.setTitle("Freebox Call Notifier — WPS")
		.setDescription("Le WPS a bien été activé sur le réseau.")
		.setColor(bacheroFunctions.colors.primary)

	// On tente d'obtenir des informations sur la carte réseau
	var bands = cache.get(`bands-${interaction.user.id}`)
	if(bands) var card = bands?.find(e => e?.id == cardId)
	if(bands && card){
		// On ajoute le mot de passe dans un field
		if(card?.password) embed.addFields({
			name: "Mot de passe",
			value: spoiler(card.password)
		})

		// On ajoute un QR code dans une image
		if(card?.password && card?.ssid){
			if(card.ssid.includes(";")) var ssid = `"${card.ssid}"`
			else var ssid = card.ssid

			if(card.password.includes(";")) var password = `"${card.password}"`
			else var password = card.password

			embed.setThumbnail(`https://chart.googleapis.com/chart?cht=qr&chs=512x512&chld=L|0&chl=${encodeURIComponent(`WIFI:T:${card?.password ? "WPA" : "nopass"};S:${encodeURI(ssid)};P:${encodeURI(password)};;`)}`)
		}
	} else embed.setFooter({ text: "Les informations détaillées ont expiré." })

	// Répondre avec l'embed
	interaction.editReply({ embeds: [embed] }).catch(err => {})
}

// Fonction pour vérifier la messagerie vocale des users, et leurs dires s'ils ont un nouveau message
// Note: pour une meilleur compatibilité, ne doit être exécuté que via le fichier slash, depuis le getClient
async function checkVoicemail(){
	// Passer en revue toutes les boxs
	for(const freebox of global.callNotifierFreeboxs){
		// On vérifie que l'utilisateur a bien un client
		if(!freebox?.client) continue

		// Si la box est injoignable, on vérifie la dernière fois qu'on a check son état
		if(freebox?.injoignable){
			// Si on a pas vérifier depuis plus de 10 minutes, on vérifie
			if(!freebox.lastStatusCheck) freebox.lastStatusCheck = Date.now() // définir la dernière vérif si on l'a jamais vérifier
			if(freebox.lastStatusCheck && freebox.lastStatusCheck < Date.now() - (1000 * 60 * 10)){
				freebox.lastStatusCheck = Date.now()
			} else continue // sinon on passe directement à la box suivante
		}

		// On obtient le client DiscordJS
		if(!botClient) botClient = bacheroFunctions.botClient.get()

		// Obtenir les messages vocaux
		var response = await freebox?.client?.fetch({
			method: "GET",
			url: "v10/call/voicemail",
			parseJson: true
		})

		// Si la box est vrm injoignable
		if(typeof response?.msg == "object" && JSON.stringify(response) == "{\"success\":false,\"msg\":{},\"json\":{}}"){
			// On vérifie qu'on a accès à internet NOUS(belek le gars sa box elle a pas down c'est nous qui avons pas internet ptdrrr)
			if(!await checkInternet()){
				bacheroFunctions.showLog("warn", "On dirait que nous n'avons pas internet", "callnotifier-voicemail-checkinternet")
				continue
			}

			// On envoie le msg et on définit la box comme injoignable
			if(!freebox.injoignable) botClient.users.fetch(freebox.userId).then(user => {
				user.send({ embeds: [generateEmbed("État de votre box", "Il semblerait que votre Freebox ne soit plus accessible. Vérifier qu'elle est toujours connectée à Internet pour continuer d'utiliser Call Notifier.", "danger")] }).catch(err => {
					if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
					bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
					return disconnectBox(freebox.userId, freebox.id)
				})
			}).catch(err => {
				if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
				bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
				bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
				return disconnectBox(freebox.userId, freebox.id)
			})
			freebox.injoignable = true
			continue
		} else {
			// Si on était injoignable
			if(freebox.injoignable) botClient.users.fetch(freebox.userId).then(user => {
				user.send({ embeds: [generateEmbed("État de votre box", "Votre Freebox semble de nouveau connecté à Internet !", "success")] }).catch(err => {
					if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
					bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
					return disconnectBox(freebox.userId, freebox.id)
				})
			}).catch(err => {
				if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
				bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
				bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
				return disconnectBox(freebox.userId, freebox.id)
			})
			freebox.injoignable = false // on est joinable
		}

		// Si on a pas pu s'autentifier
		if(response?.msg == "Erreur d'authentification de l'application"){
			await disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
			botClient.users.fetch(freebox.userId).then(user => {
				user.send({ embeds: [generateEmbed("État de votre box", "Une erreur d'authentification est survenue. Veuillez vous reconnecter via le terminal.", "danger")] }).catch(err => {})
			}).catch(err => {})
			continue
		}

		// Si il y a une erreur, informer l'utilisateur
		if(!response?.success){
			// Si l'app n'a pas la permission
			if(response?.msg == "Cette application n'est pas autorisée à accéder à cette fonction"){
				await disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
				botClient.users.fetch(freebox.userId).then(user => {
					user.send({ embeds: [generateEmbed("État de votre box", "Call Notifier n'a pas la permission d'accéder aux appels. Veuillez vous reconnecter via le terminal.", "danger")] }).catch(err => {})
				}).catch(err => {})
				continue
			}

			// Si le challenge a pas marché, on ignore
			if(response?.msg?.startsWith("No challenge was given for an unknown reason")){
				bacheroFunctions.showLog("warn", `Le challenge n'a pas marché(wtf) pour l'utilisateur ${freebox.chatId || freebox.userId} : `, "callnotifier-voicemail")
				bacheroFunctions.showLog("warn", response, "callnotifier-voicemail", true, true)
				continue
			}

			// Sinon on envoie un simple message d'erreur(ça risque de spam l'utilisateur mais bon)
			else botClient.users.fetch(freebox.userId).then(user => {
				user.send({ embeds: [generateEmbed("État de votre box", `Une erreur est survenue${response?.msg || response?.message || typeof response == "object" ? ` : ${response.msg || response.message || JSON.stringify(response)}` : "... Signaler ce problème."}`, "danger")] }).catch(err => {
					if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
					bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
					return disconnectBox(freebox.userId, freebox.id)
				})
			}).catch(err => {
				if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
				bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
				bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
				return disconnectBox(freebox.userId, freebox.id)
			})
			continue
		}

		// On trie les messages vocaux par date(du plus récent au plus ancien)
		if(response?.result?.length) response = response.result.sort((a, b) => b.date - a.date)

		// Si c'est la première itération, on enregistre des infos et on passe à la suivante
		if(!freebox.checkVoicemailfirstIterationPassed){
			freebox.voicemail = {
				length: response?.length || 0,
				gotOne: false,
				duration: null, // nécessaire car l'API envoie les vocaux avant qu'ils soient finalisés
				duration2: null // on doit vérifier deux fois que la durée a changé pour être sûr que le vocal est finalisé
			}
			freebox.checkVoicemailfirstIterationPassed = true
			continue
		}

		// Récupérer la taille du tableau
		var newLength = response?.length || 0

		// Si on a pas de vocs, on continue
		if(!newLength){
			if(newLength != freebox.voicemail.length) freebox.voicemail.length = newLength // On met à jour la taille
			continue
		}

		// Si on a un NOUVEAU message vocal
		else if(newLength > freebox.voicemail.length && freebox.voicemail.msgId != response?.[0]?.id){
			freebox.voicemail.msgId = response?.[0]?.id || null
			freebox.voicemail.duration = response?.[0]?.duration || null
			freebox.voicemail.gotOne = true
			freebox.voicemail.length = newLength // On met à jour la taille
			continue
		}

		// Si on a des vocaux en moins
		else if(newLength < freebox.voicemail.length){
			freebox.voicemail.length = newLength // On met à jour la taille
			continue // On continue
		}

		// Si on a autant de vocaux
		else if(newLength == freebox.voicemail.length && freebox.voicemail.gotOne){
			// On obtient la nouvelle durée
			var newDuration = response?.[0]?.duration || null

			// Si la durée a changé deux fois, on déduit que le vocal est finalisé
			if(newDuration == freebox.voicemail.duration2 && freebox.lastVoicemailId != freebox.voicemail.msgId){
				// On envoie le message vocal
				freebox.voicemail.gotOne = false
				freebox.voicemail.duration = newDuration
				freebox.lastVoicemailId = freebox.voicemail.msgId

				// On enregistre que le message vocal a été envoyé
				var { error } = await supabase.from("users").update({ lastVoicemailId: freebox.voicemail.msgId }).match({ userId: freebox.userId || freebox.chatId, platform: "discord" })
				if(error){
					bacheroFunctions.showLog("error", `Impossible de mettre à jour les données de l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("error", error, "callnotifier-voicemail", true, true)
					continue
				}

				// On récupère le nom du contact
				var callerNumber = response?.[0]?.phone_number
				var contactName
				if(callerNumber){
					var contacts = await freebox?.client?.fetch({
						method: "GET",
						url: "v10/contact/",
						parseJson: true
					})
					if(contacts?.result?.length) contactName = contacts?.result?.find(e => e?.numbers?.find(f => f?.number == `0${callerNumber}`))?.display_name || null
				}

				// On obtient un buffer du message vocal
				var buffer
				try {
					buffer = await freebox?.client?.fetch({
						method: "GET",
						url: `v10/call/voicemail/${freebox.voicemail.msgId}/audio_file`
					})
					buffer = await buffer.buffer()
				} catch(err){
					buffer = null
					bacheroFunctions.showLog("error", `Impossible d'obtenir le message vocal de la Freebox ${getFreeboxName(freebox.boxModel)} pour l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("error", err, "callnotifier-voicemail", true, true)
					continue
				}

				// Envoyer le message à l'utilisateur
				botClient.users.fetch(freebox.userId).then(user => {
					// On fait un embed
					var embed = new EmbedBuilder()
						.setTitle("Freebox Call Notifier — Nouveau message vocal")
						.addFields([
							{
								name: "Numéro",
								value: `${contactName ? `${contactName} - ` : ""}${callerNumber ? `0${callerNumber}` : "Numéro inconnu"}`,
								inline: true
							},
							response?.[0]?.duration ? {
								name: "Durée",
								value: `${Math.floor(response[0].duration / 60)}:${(response[0].duration % 60).toString().padStart(2, "0")}`,
								inline: true
							} : null,
							response?.[0]?.date ? {
								name: "Date",
								value: `<t:${Math.floor(response?.[0]?.date)}:F>`,
							} : null
						].filter(e => e))
						.setColor(bacheroFunctions.colors.primary)

					// On envoie le message
					user.send({ embeds: [embed], files: [{ attachment: buffer, name: "message_vocal.mp3" }] }).catch(err => {
						if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
						bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
						bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
						return disconnectBox(freebox.userId, freebox.id)
					})
				}).catch(err => {
					if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
					bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${freebox.userId} : `, "callnotifier-voicemail")
					bacheroFunctions.showLog("warn", err, "callnotifier-voicemail", true, true)
					return disconnectBox(freebox.userId, freebox.id)
				})

				// Passer au suivant
				continue
			}

			// Si la durée a changé qu'une fois, on met à jour la durée
			else if(newDuration == freebox.voicemail.duration && freebox.lastVoicemailId != freebox.voicemail.msgId) freebox.voicemail.duration2 = newDuration
			else freebox.voicemail.duration = newDuration
		}

		// On met à jour la variable qui indique que la première itération est passée
		if(!freebox.checkVoicemailfirstIterationPassed) freebox.checkVoicemailfirstIterationPassed = true

		// On attend vite fait
		await new Promise(r => setTimeout(r, 2000))
	}

	// On attend 12 secondes avant de retenter d'obtenir les vocs
	// Nécessaire puisque l'API renvoie une réponse mise à jour qu'après 10 secondes(et 12sec au lieu de 10 c'est pour être sûr)
	return setTimeout(() => checkVoicemail(), 12000)
}

// Fonction pour vérifier les appels entrants sur une box
// Note: pour une meilleur compatibilité, ne doit être exécuté que via le fichier slash, depuis le getClient
async function checkCalls(){
	// Passer en revue toutes les boxs
	for(const freebox of global.callNotifierFreeboxs){
		// On vérifie que l'utilisateur a bien un client
		if(!freebox?.client) continue
		if(freebox?.injoignable) continue

		// On obtient le client DiscordJS
		if(!botClient) botClient = bacheroFunctions.botClient.get()

		// Obtenir l'historique d'appel
		var response = await freebox?.client?.fetch({
			method: "GET",
			url: "v10/call/log/",
			parseJson: true
		})

		// Si on a pas pu s'autentifier
		if(response?.msg == "Erreur d'authentification de l'application"){
			await disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
			botClient.users.fetch(freebox.userId).then(user => {
				user.send({ embeds: [generateEmbed("État de votre box", "Une erreur d'authentification est survenue. Veuillez vous reconnecter via le terminal.", "danger")] }).catch(err => {})
			}).catch(err => {})
			continue
		}

		// Si il y a une erreur, informer l'utilisateur
		if(!response?.success){
			// Si l'app n'a pas la permission
			if(response?.msg == "Cette application n'est pas autorisée à accéder à cette fonction"){
				await disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
				botClient.users.fetch(freebox.userId).then(user => {
					user.send({ embeds: [generateEmbed("État de votre box", "Call Notifier n'a pas la permission d'accéder aux appels. Veuillez vous reconnecter via le terminal.", "danger")] }).catch(err => {})
				}).catch(err => {})
				continue
			}

			// Sinon, juste on log
			bacheroFunctions.showLog("error", `Impossible d'obtenir l'historique d'appel de la Freebox ${getFreeboxName(freebox.boxModel)} pour l'utilisateur ${freebox.userId} : `, "callnotifier-calls")
			bacheroFunctions.showLog("error", response, "callnotifier-calls", true, true)
			continue
		}

		// On récupère le dernier appel
		response = response?.result?.[0] || null
		if(!response) continue

		// On ignore les appels qui ne sont pas entrants
		if(response.type == "outgoing") continue

		// Si le dernier appel est le même
		if(response.id == freebox?.lastCallId) continue

		// Enregistrer le nouveau "dernier id"
		if(!freebox?.lastCallId){
			freebox.lastCallId = response.id
			continue
		} else freebox.lastCallId = response.id

		// Mettre un espace tous les 2 chiffres
		if(response?.name == response?.number) response.name = null
		if(response.number) response.number = response.number.toString().replace(/\B(?=(\d{2})+(?!\d))/g, " ")

		// Envoyer le message à l'utilisateur
		botClient.users.fetch(freebox.userId).then(user => {
			user.send({ embeds: [generateEmbed("Appel entrant", `**${response?.name || response?.number || "Numéro masqué"}**${response.name ? ` (${response?.number})` : ""} vous appelle !`, "primary")] }).catch(err => {
				if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
				bacheroFunctions.showLog("warn", `Impossible de contacter l'utilisateur ${freebox.userId} : `, "callnotifier-calls")
				bacheroFunctions.showLog("warn", err, "callnotifier-calls", true, true)
				return disconnectBox(freebox.userId, freebox.id)
			})
		}).catch(err => {
			if(err.code == "ECONNRESET" || err.code == "ECONNREFUSED" || err.code == "ETIMEDOUT" || err.code == "ENOTFOUND" || err.code == "EAI_AGAIN" || err.code == "ECONNABORTED") return
			bacheroFunctions.showLog("warn", `Impossible de retrouver l'utilisateur ${freebox.userId} : `, "callnotifier-calls")
			bacheroFunctions.showLog("warn", err, "callnotifier-calls", true, true)
			return disconnectBox(freebox.userId, freebox.id)
		})

		// On attend vite fait
		await new Promise(r => setTimeout(r, 100))
	}

	// On attend un peu avant de retenter d'obtenir les appels
	return setTimeout(() => checkCalls(), 600)
}

// Exporter certaines fonctions
module.exports = {
	// Définir les infos de la commande slash
	slashInfo: new SlashCommandBuilder()
		.setName("callnotifier")
		.setDescription("Gère le service Freebox Call Notifier")
		.setDefaultMemberPermissions(0) // masque la commande sur les serveurs par défaut, les admins peuvent la réactiver donc on vérifiera à chaque exécution
		.addSubcommand((subcommand) => subcommand
			.setName("info")
			.setDescription("Affiche des informations sur le fonctionnement de Call Notifier"))
		.addSubcommand((subcommand) => subcommand
			.setName("link")
			.setDescription("Vous guide à travers les étapes de configuration"))
		.addSubcommand((subcommand) => subcommand
			.setName("unlink")
			.setDescription("Déconnecte et supprime votre Freebox de notre base de données"))
		.addSubcommand((subcommand) => subcommand
			.setName("support")
			.setDescription("Permet de contacter les développeurs"))
		.addSubcommand((subcommand) => subcommand
			.setName("debug")
			.setDescription("Facilite le débogage du service, à utiliser sur demande du support"))
		.addSubcommand((subcommand) => subcommand
			.setName("phone")
			.setDescription("Affiche votre numéro de téléphone fixe"))
		.addSubcommand((subcommand) => subcommand
			.setName("wps")
			.setDescription("Active la connexion Wi-Fi via WPS sur une de vos cartes réseaux"))
		.addSubcommandGroup((subcommandGroup) => subcommandGroup
			.setName("contact")
			.setDescription("Gère les contacts de votre box")
			.addSubcommand((subcommand) => subcommand
				.setName("show")
				.setDescription("Affiche un contact")
				.addStringOption((option) => option
					.setName("name")
					.setDescription("Nom du contact")
					.setMinLength(1)
					.setMaxLength(99)
					.setRequired(true)))
			.addSubcommand((subcommand) => subcommand
				.setName("add")
				.setDescription("Ajoute un contact")
				.addStringOption((option) => option
					.setName("name")
					.setDescription("Nom du contact")
					.setMinLength(1)
					.setMaxLength(48)
					.setRequired(true))
				.addIntegerOption((option) => option
					.setName("number")
					.setDescription("Numéro du contact")
					.setMinValue(1)
					.setMaxValue(9999999999)
					.setRequired(true)))
			.addSubcommand((subcommand) => subcommand
				.setName("delete")
				.setDescription("Supprime un contact")
				.addStringOption((option) => option
					.setName("name")
					.setDescription("Nom du contact")
					.setMinLength(1)
					.setMaxLength(99)
					.setRequired(true)))),

	// Quand le bot est connecté à Discord
	async getClient(client){
		// Définir le client
		if(!botClient) botClient = client

		// Mettre à jour les données périodiquement
		getSupabaseUsers()
		setInterval(() => getSupabaseUsers(), 1000 * 60 * 5)

		// Tâche en arrière plan pour vérifier les messages vocaux
		checkVoicemail()
		checkCalls()
	},

	// Récupérer le listener d'interaction
	async interactionListener(listener){
		// Pour les boutons
		listener.on("button", async(interaction) => {
			// On vérifie le customId et qu'on est en dm
			if(!interaction.customId.startsWith("callnotifier-") || interaction.inGuild() || interaction.guildId) return

			// Bouton universel pour annuler une action
			if(interaction.customId == "callnotifier-cancel") return await interaction.update({ content: "Annulée.", embeds: [], components: [] }).catch(err => {})

			// Si on a pas fini de synchroniser les données, on refuse
			if(!global.callNotifierSyncedOnce) return interaction.reply({ content: "Le service est encore en cours de synchronisation, cela ne devrait pas prendre beaucoup de temps." }).catch(err => {})

			// Se déconnecter
			if(interaction.customId == "callnotifier-unlink"){
				// On déconnecte la box
				var isDeleted = await disconnectBox(interaction.user.id, interaction.user.id)

				// On met à jour les données Supabase
				await getSupabaseUsers()

				// On supprime certains éléments du cache
				cache.del(`phone-${interaction.user.id}`)
				cache.del(`bands-${interaction.user.id}`)

				// On répond
				return await interaction.update({ content: isDeleted ? "Vous avez été déconnecté avec succès. Une attente de quelques minutes est nécessaire avant la suppression totale de vos données." : "En raison d'une erreur inconnue, nous n'avons pas pu vous contacter. Vous pouvez contacter le support via la commande `/callnotifier support`", embeds: [], components: [] }).catch(err => {})
			}

			// Afficher le modal permettant d'entrer un code d'association
			if(interaction.customId == "callnotifier-typecode"){
				// Répondre avec le modal
				interaction.showModal(new ModalBuilder()
					.setCustomId("callnotifier-typecode")
					.setTitle("Terminer l'association")
					.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
						.setCustomId("callnotifier-code")
						.setLabel("Code d'association")
						.setStyle(TextInputStyle.Short)
						.setRequired(true)
						.setMinLength(6)
						.setMaxLength(6)))).catch(err => {})

				// Supprimer le message d'origine
				await interaction.deleteReply().catch(err => {})
			}
		})

		// Pour les modals
		listener.on("modal", async(interaction) => {
			// On vérifie le customId et qu'on est en dm
			if(!interaction.customId.startsWith("callnotifier-") || interaction.inGuild() || interaction.guildId) return

			// Si on a pas fini de synchroniser les données, on refuse
			if(!global.callNotifierSyncedOnce) return interaction.reply({ content: "Le service est encore en cours de synchronisation, cela ne devrait pas prendre beaucoup de temps." }).catch(err => {})

			// Saisir un code d'association
			if(interaction.customId == "callnotifier-typecode"){
				// Obtenir le code
				var code = interaction?.fields?.getTextInputValue("callnotifier-code")

				// On vérifie que le code est valide
				if(!code.match(/^[0-9]{6}$/)) return interaction.reply({ content: "Le code entré n'est pas valide. Veuillez réessayer." }).catch(err => {})

				// On vérifie qu'il n'a pas déjà associé une Freebox
				if(global.callNotifierUsers.find(e => e.userId == interaction.user.id)) return interaction.reply({ content: "Vous avez déjà associé une Freebox à votre compte Discord. Si vous souhaitez la supprimer, vous pouvez utiliser la commande `/callnotifier unlink`." }).catch(err => {})

				// On defer la réponse
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// Obtenir le code unique dans la base de données
				var { data, error } = await supabase.from("uniquecode").select("*").eq("code", code)
				if(error) return interaction.editReply({ content: "Une erreur est survenue et nous n'avons pas pu récupérer les informations de ce code dans la base des données. Veuillez signaler ce problème via la commande `/callnotifier support`" }).catch(err => {})

				// Si on a pas de données
				if(!data?.length) return interaction.editReply({ content: "Oups, on dirait bien que ce code n'existe pas. Celui-ci a peut-être expiré, ou est mal écrit. Dans le cas où vous hébergez vous-même le service, vérifier que vous avez entré la bonne URL d'API lors de l'utilisation du CLI." }).catch(err => {})

				// Si on a un code, on l'associe à l'utilisateur
				var { error } = await supabase.from("uniquecode").delete().match({ code: code })
				if(error) interaction.editReply({ content: "Nous n'avons pas pu supprimer ce code d'association, il expirera tout de même dans moins d'une heure. Veuillez signaler ce problème via la commande `/callnotifier support`" }).catch(err => {})

				// Si on a des données, on vérifie qu'elles ne sont pas expirées
				var infos = data?.[0]
				if(infos?.created){
					var created = new Date(data?.created)
					if(created < new Date(Date.now() - (1000 * 60 * 50))) return interaction.editReply({ content: "Oups, on dirait bien que ce code a expiré. Veuillez en générer un nouveau." }).catch(err => {}) // 50 minutes
				}

				// On vérifie que l'utilisateur n'a pas déjà associé une box(dans Supabase directement, double-vérif tu connais)
				var { data, error } = await supabase.from("users").select("*").eq("userId", interaction.user.id).eq("platform", "discord")
				if(error) return interaction.editReply({ content: "Une erreur est survenue et nous n'avons pas pu vérifier si vous avez déjà associé une Freebox à votre compte. Veuillez signaler ce problème." }).catch(err => {})
				if(data?.length) return interaction.editReply({ content: "Vous avez déjà associé une Freebox à votre compte, utiliser `/callnotifier unlink` pour la supprimer." }).catch(err => {})

				// On vérifie que cette box n'a pas déjà été associé sur une autre plateforme(on vérifie apiDomain + httpsPort)
				var { data, error } = await supabase.from("users").select("*").eq("apiDomain", infos?.content?.apiDomain).eq("httpsPort", infos?.content?.httpsPort)
				if(error) return interaction.editReply({ content: "Une erreur est survenue et nous n'avons pas pu vérifier si cette Freebox a déjà été associé à quelqu'un. Veuillez signaler ce problème." }).catch(err => {})
				if(data?.length){
					// On l'a supprime
					var { error } = await supabase.from("users").delete().match({ apiDomain: infos?.content?.apiDomain, httpsPort: infos?.content?.httpsPort })
					if(error) return interaction.editReply({ content: "Une erreur est survenue et nous n'avons pas pu supprimer les données déjà existante de la Freebox. Veuillez signaler ce problème." }).catch(err => {})

					// On prévient l'utilisateur
					await interaction.editReply({ content: `Cette Freebox a déjà été associé à un compte via ${data[0]?.platform}. Nous avons déconnecté votre Freebox de cet utilisateur.` }).catch(err => {})
				}

				// On associe le code à l'utilisateur
				var { error } = await supabase.from("users").insert({
					id: Date.now() + Math.floor(Math.random() * 1000000).toString(),
					userId: interaction.user.id,
					chatId: interaction.user.id, // requis pour la meilleure compatibilité avec les autres plateformes
					appId: "fbx.notifier",
					appToken: infos?.content?.appToken,
					apiDomain: infos?.content?.apiDomain,
					httpsPort: infos?.content?.httpsPort,
					boxModel: infos?.content?.boxModel,
					created: new Date(),
					platform: "discord"
				})
				if(error){
					bacheroFunctions.showLog("error", `Impossible d'associer l'utilisateur ${interaction.user.id} à la Freebox ${infos?.content?.boxModel} : `, "callnotifier-association")
					bacheroFunctions.showLog("error", error, "callnotifier-association", true, true)
					return interaction.editReply({ content: "Une erreur est survenue et nous n'avons pas pu vous associer à votre Freebox. Veuillez signaler ce problème." }).catch(err => {})
				}

				// Tout est bon !
				await getSupabaseUsers() // on met à jour les données
				return interaction.editReply({ content: `Votre compte Discord a bien été associé à votre Freebox ${getFreeboxName(infos?.content?.boxModel)} !\n\nVous devrez peut-être attendre quelques minutes avant de pouvoir utiliser les commandes liés à Call Notifier, le temps que la synchronisation s'effectue.` }).catch(err => {})
			}
		})

		// Pour les select menu
		listener.on("selectMenu", async(interaction) => {
			// On vérifie le customId et qu'on est en dm
			if(!interaction.customId.startsWith("callnotifier-") || interaction.inGuild() || interaction.guildId) return

			// Si on a pas fini de synchroniser les données, on refuse
			if(!global.callNotifierSyncedOnce) return interaction.reply({ content: "Le service est encore en cours de synchronisation, cela ne devrait pas prendre beaucoup de temps." }).catch(err => {})

			// Activer le WPS sur une carte
			if(interaction.customId == "callnotifier-wps"){
				// Obtenir l'ID de la carte
				var cardId = interaction?.values?.[0]?.split("-")?.[2]

				// Obtenir la freebox de l'utilisateur
				var freebox = global.callNotifierFreeboxs.find(e => e.userId == interaction.user.id)
				if(!freebox) return interaction.reply({ content: "Nous n'avons pas pu vous identifier. Réessayer d'utiliser la commande `/callnotifier wps`." }).catch(err => {})

				// Si on est pas joignable, on le dit
				if(freebox?.injoignable) return interaction.reply({ embeds: [generateEmbed("État de votre box", "Nous n'avons pas la possibilité de nous connecter à votre Freebox à l'heure actuel. Une tentative de reconnexion est effectuée toutes les dix minutes et vous serez notifié lorsque nous y parviendrons !", "danger")] }).catch(err => {})

				// On defer la réponse
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// On active le WPS
				activateWPS(freebox.client, cardId, interaction)
			}
		})
	},

	// Code à exécuter quand la commande est appelée
	async execute(interaction){
		// Si on est sur un serveur, on refuse
		if(interaction.inGuild() || interaction.guildId) return interaction.reply({ content: "Cette commande ne peut pas être utilisée sur un serveur, vous devez l'exécuter en message privé.", ephemeral: true }).catch(err => {})

		// Si on a pas fini de synchroniser les données, on refuse
		if(!global.callNotifierSyncedOnce) return interaction.reply({ content: "Le service est encore en cours de synchronisation, cela ne devrait pas prendre beaucoup de temps." }).catch(err => {})

		// Les groupes de sous-commandes ne sont pas encore supportés en commande texte dans Bachero
		if(interaction.sourceType == "textCommand"){
			var subcommand = interaction?.args?.[0]?.split(" ")?.[0]
			if(subcommand && this.slashInfo.options.find(a => a.name == subcommand).name == "contact"){ // <-- on mettra à jour ici pour vérifier toutes les subcommandgroups
				return interaction.reply({ content: "Cette commande n'est pas encore disponible en commande texte, veuillez utiliser la commande slash." }).catch(err => {})
			}
		}

		// Sous commande "info"
		if(interaction.options.getSubcommand() === "info"){
			return interaction.reply({ embeds: [generateEmbed(
				"Informations",
				`Le service Freebox Call Notifier vous permet, si vous avez une Freebox, de recevoir un message privé lorsque vous recevez un appel sur votre téléphone fixe.\nPour cela, vous aurez besoin d'associer votre Freebox à ${botName} via la commande \`callnotifier link\`.\n\n> 🧷 Ce service est open-source, vous pouvez voir le code sources des différents dépôts via GitHub : [Module Bachero](https://github.com/Freebox-Tools/bachero-call-notifier) ; [Bot Telegram](https://github.com/Freebox-Tools/telegram-call-notifier) ; [API](https://github.com/Freebox-Tools/api-notifier) ; [CLI](https://github.com/Freebox-Tools/cli-notifier) ; [Wrapper NodeJS](https://github.com/Freebox-Tools/freebox-wrapper).\n\n> 🤖 Vous pouvez également utiliser ce service via [Telegram](https://t.me/freebox_call_notifier_bot) et bientôt WhatsApp.\n\n> ❓ Toutes questions ou signalements peut s'effectuer via la commande \`callnotifier support\`. Nous ne sommes pas affiliés à Free et Iliad.`
			)] }).catch(err => {})
		}

		// Sous commande "link"
		if(interaction.options.getSubcommand() === "link"){
			// On vérifie qu'il n'a pas déjà associé une Freebox
			if(global.callNotifierUsers.find(e => e.userId == interaction.user.id)) return interaction.reply({ embeds: [generateEmbed("Association", "Vous avez déjà associé une Freebox à votre compte Discord. Si vous souhaitez la supprimer, vous pouvez utiliser la commande `/callnotifier unlink`.", "secondary")] }).catch(err => {})

			// Créer un embed
			var embed = generateEmbed(
				"Association",
				"Pour associer une Freebox à votre compte Discord, vous devrez utiliser l'assistant de configuration via terminal sur un ordinateur connecté au même réseau que votre Freebox.\n\n1. Assurez-vous d'avoir [Node.js](https://nodejs.dev/fr/download/) installé sur votre ordinateur.\n2. Ouvrez un terminal(\"Invite de commandes\" sur Windows 10).\n3. Dans ce terminal, entrez la commande suivante : `npx freebox-notifier-cli`\n4. Suivez les instructions affichées dans le terminal.\n5. Appuyer sur le bouton ci-dessous pour saisir le code.\n\nEn cas de problème, vous pouvez utiliser la commande `/callnotifier support`.\n*Non-affilié à Free et Iliad.*"
			)

			// Créer un bouton
			var row = new ActionRowBuilder().addComponents(new ButtonBuilder()
				.setCustomId("callnotifier-typecode")
				.setLabel("Saisir le code d'association")
				.setStyle(ButtonStyle.Primary))

			// Répondre à l'interaction
			return interaction.reply({ embeds: [embed], components: [row] }).catch(err => {})
		}

		// Sous commande "unlink"
		if(interaction.options.getSubcommand() === "unlink"){
			// On vérifie qu'il a associé une Freebox
			if(!global.callNotifierUsers.find(e => e.userId == interaction.user.id)) return interaction.reply({ embeds: [generateEmbed("Association", "Vous n'avez pas associé de Freebox à votre compte Discord. Si vous souhaitez en associer une, vous pouvez utiliser la commande `/callnotifier link`.", "secondary")] }).catch(err => {})

			// Créer un embed
			var embed = generateEmbed(
				"Déconnexion",
				"⚠️ Lors de la déconnexion, toutes les données enregistrées sur nos serveurs seront supprimées et vous ne serez plus notifié lors d'un appel entrant.\nSi vous souhaitez vous reconnecter plus tard, vous devrez effectuer une nouvelle association via un terminal.",
				"danger"
			)

			// Créer les boutons
			var row = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId("callnotifier-unlink")
					.setLabel("Oui, se déconnecter")
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId("callnotifier-cancel")
					.setLabel("Annuler")
					.setStyle(ButtonStyle.Secondary)
			)

			// Répondre
			return interaction.reply({ embeds: [embed], components: [row] }).catch(err => {})
		}

		// Sous commande "support"
		if(interaction.options.getSubcommand() === "support"){
			// Créer un embed
			var embed = generateEmbed(
				"Support",
				"Vous pouvez nous contacter via les moyens ci-dessous pour n'importe quelle question, suggestion, signalement ou réclamation.\nVous pouvez également utiliser l'adresse mail **johan@johanstick.fr**"
			)

			// Créer les boutons
			var rows = [
				new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setURL("https://discord.gg/SWkh4mk")
						.setStyle(ButtonStyle.Link)
						.setLabel("Discord(serveur)"),
					new ButtonBuilder()
						.setURL("https://github.com/Freebox-Tools/bachero-call-notifier")
						.setStyle(ButtonStyle.Link)
						.setLabel("GitHub(code source)")
				),
				new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setURL("https://t.me/JohanStick")
						.setStyle(ButtonStyle.Link)
						.setLabel("Telegram(Johan)"),
					new ButtonBuilder()
						.setURL("https://t.me/el2zay")
						.setStyle(ButtonStyle.Link)
						.setLabel("Telegram(el2zay)")
				)]

			// Répondre
			return interaction.reply({ embeds: [embed], components: [...rows] }).catch(err => {})
		}

		// Sous commande "debug"
		if(interaction.options.getSubcommand() === "debug"){
			// Créer un embed(sans utiliser la fonction car il sera plus complet)
			var embed = new EmbedBuilder()
				.setTitle("Freebox Call Notifier — Débogage")
				.setColor(bacheroFunctions.colors.primary)

			// Obtenir des informations
			var user = global.callNotifierUsers.find(e => e.userId == interaction.user.id)
			var freebox = global.callNotifierFreeboxs.find(e => e.userId == interaction.user.id)

			// Afficher des informations sur l'utilisateur
			if(!user) embed.addFields({ name: "Utilisateur(BDD)", value: "Aucune information n'est en cache. La synchronisation n'a peut-être pas eu lieu." })
			else embed.addFields({ name: "Utilisateur(BDD)", value: codeBlock(`userId: ${user?.userId}\nchatId: ${user?.chatId}\nplatform: ${user?.platform}\n\nappId: ${user?.appId}\nappToken: ${censorString(user?.appToken)}\napiDomain: ${user?.apiDomain}\nhttpsPort: ${user?.httpsPort}\n\nboxModel: ${user?.boxModel}\nlastVoicemailId: ${user?.lastVoicemailId}\ncreated: ${user?.created}\nid: ${user?.id}`) })

			// Afficher des informations sur le client
			if(!freebox) embed.addFields({ name: "Client Freebox", value: "Aucune information n'est en cache. La synchronisation n'a peut-être pas eu lieu." })
			else embed.addFields({ name: "Client Freebox", value: codeBlock(`appToken: ${censorString(freebox?.client?.options?.appToken)}\nsessionToken: ${censorString(freebox?.client?.sessionToken)}\n\n${freebox?.client?.freebox ? Object.entries(freebox?.client?.freebox).map(e => `${e[0]}: ${e[1]}`).join("\n") : "<impossible d'afficher les détails>"}`) })

			// Afficher des informations sur des fonctions
			var bands = cache.get(`bands-${interaction.user.id}`)
			embed.addFields({ name: "Fonctions et cache", value: codeBlock(`getFreeboxName():\n      ${user?.boxModel}\n  →   ${getFreeboxName(user?.boxModel)}\n\nphone-${interaction.user.id}:\n      ${cache.get(`phone-${interaction.user.id}`)}\n\nbands-${interaction.user.id}:\n      ${bands?.length ? JSON.stringify(bands?.map(a => { a.password = censorString(a?.password); return a })) : undefined}\n\nfreebox.voicemail:\n      ${freebox.voicemail ? JSON.stringify(freebox.voicemail) : undefined}\n\nfreebox.checkVoicemailfirstIterationPassed:\n      ${freebox?.checkVoicemailfirstIterationPassed}\n\nfreebox.injoignable:\n      ${freebox?.injoignable}`) })

			// Répondre avec l'embed
			return interaction.reply({ embeds: [embed] }).catch(err => {})
		}

		// Sous commande "phone"
		if(interaction.options.getSubcommand() === "phone"){
			// On vérifie si on a déjà un numéro en cache
			var number = cache.get(`phone-${interaction.user.id}`)

			// On détermine l'action qu'on doit faire avec l'interaction (répondre ou modifier la réponse)
			if(!bands) var action = "editReply"
			else var action = "reply"

			// Si on a pas le numéro en cache, on l'obtient
			if(!number || !number?.length){
				// On vérifie qu'il a associé une Freebox
				if(!global.callNotifierUsers.find(e => e.userId == interaction.user.id)) return interaction.reply({ embeds: [generateEmbed("Association", "Vous n'avez pas associé de Freebox à votre compte Discord. Si vous souhaitez en associer une, vous pouvez utiliser la commande `/callnotifier link`.", "secondary")] }).catch(err => {})

				// On vérifie qu'on a un client
				var freebox = global.callNotifierFreeboxs.find(e => e.userId == interaction.user.id)
				if(!freebox) return interaction.reply({ embeds: [generateEmbed("Association", "Votre Freebox semble être en cours de synchronisation. Vous pourrez réessayer dans un court instant.", "secondary")] }).catch(err => {})

				// Si on est pas joignable, on le dit
				if(freebox?.injoignable) return interaction.reply({ embeds: [generateEmbed("État de votre box", "Nous n'avons pas la possibilité de nous connecter à votre Freebox à l'heure actuel. Une tentative de reconnexion est effectuée toutes les dix minutes et vous serez notifié lorsque nous y parviendrons !", "danger")] }).catch(err => {})

				// On defer la réponse
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// On récupère le numéro de téléphone
				var response = await freebox?.client?.fetch({
					method: "GET",
					url: "v10/call/account/",
					parseJson: true
				})
				if(!response?.success) return interaction[action]({ embeds: [generateEmbed("Numéro de téléphone", `Nous n'avons pas pu récupérer votre numéro de téléphone : ${response?.msg || response?.error?.msg || response?.message || response?.error?.message}`, "secondary")] }).catch(err => {})

				// On enregistre le numéro en cache
				number = response?.result?.phone_number
				cache.set(`phone-${interaction.user.id}`, number, 60 * 60 * 6) // 6h
			}

			// On répond
			return interaction[action]({ embeds: [generateEmbed("Numéro de téléphone", `Votre numéro de téléphone fixe est le : **${number}**`)] }).catch(err => {})
		}

		// Sous commande "wps"
		if(interaction.options.getSubcommand() === "wps"){
			// On vérifie qu'il a associé une Freebox
			if(!global.callNotifierUsers.find(e => e.userId == interaction.user.id)) return interaction.reply({ embeds: [generateEmbed("Association", "Vous n'avez pas associé de Freebox à votre compte Discord. Si vous souhaitez en associer une, vous pouvez utiliser la commande `/callnotifier link`."), "secondary"] }).catch(err => {})

			// On vérifie qu'on a un client
			var freebox = global.callNotifierFreeboxs.find(e => e.userId == interaction.user.id)
			if(!freebox) return interaction.reply({ embeds: [generateEmbed("Association", "Votre Freebox semble être en cours de synchronisation. Vous pourrez réessayer dans un court instant."), "secondary"] }).catch(err => {})

			// Récupérer les réseaux en cache
			var bands = cache.get(`bands-${interaction.user.id}`)

			// On détermine l'action qu'on doit faire avec l'interaction (répondre ou modifier la réponse)
			if(!bands) var action = "editReply"
			else var action = "reply"

			// Les chercher si on ne les a pas en cache
			if(!bands){
				// Si on est pas joignable, on le dit
				if(freebox?.injoignable) return interaction.reply({ embeds: [generateEmbed("État de votre box", "Nous n'avons pas la possibilité de nous connecter à votre Freebox à l'heure actuel. Une tentative de reconnexion est effectuée toutes les dix minutes et vous serez notifié lorsque nous y parviendrons !", "danger")] }).catch(err => {})

				// On defer la réponse
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// Les obtenir
				var response = await freebox?.client?.fetch({
					method: "GET",
					url: "v9/wifi/bss",
					parseJson: true
				})
				if(response?.result?.length) response.result = response.result.filter(e => e.config.enabled && e.config.wps_enabled) // on filtre pour n'avoir que les réseaux sur lesquels le WPS est activé

				// Les mettre en forme
				if(response?.result?.length) bands = response?.result.map(e => {
					return { band: e?.status?.band, id: e?.id, ssid: e?.config?.ssid, password: e?.config?.key }
				})

				// Les enregistrer en cache
				cache.set(`bands-${interaction.user.id}`, bands, 60 * 30) // 30min
			}

			// Si on a pas de réseaux, on le dit
			if(!bands?.length) return interaction[action]({ embeds: [generateEmbed("WPS", "Le WPS n'est activé sur aucune des cartes réseaux. Vous pouvez vous rendre sur Freebox OS pour l'activer manuellement.", "danger")] }).catch(err => {})

			// Si on a qu'une seule carte, on l'active directement
			if(bands?.length == 1) return activateWPS(freebox?.client, bands[0]?.id, interaction)

			// Demander à l'utilisateur la carte à utiliser
			const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
				.setCustomId("callnotifier-wps")
				.setPlaceholder("Sélectionnez une carte réseau à utiliser")
				.addOptions(bands.map(e => {
					return new StringSelectMenuOptionBuilder()
						.setLabel(e.ssid)
						.setDescription(e.band == "5G" ? "Réseau 5 GHz" : e.band == "2G4" ? "Réseau 2.4 GHz" : e.band)
						.setValue(`callnotifier-wps-${e.id}`)
				})))

			// Répondre
			return interaction[action]({ components: [row] }).catch(err => {})
		}

		// Sous commande "contact"
		if(interaction.options.getSubcommandGroup() === "contact"){
			// On obtient et vérifie la freebox
			var freebox = global.callNotifierFreeboxs.find(e => e.userId == interaction.user.id)
			if(!freebox) return interaction.reply({ embeds: [generateEmbed("Association", "Votre Freebox semble être en cours de synchronisation. Vous pourrez réessayer dans un court instant.", "secondary")] }).catch(err => {})

			// Si on est pas joignable, on le dit
			if(freebox?.injoignable) return interaction.reply({ embeds: [generateEmbed("État de votre box", "Nous n'avons pas la possibilité de nous connecter à votre Freebox à l'heure actuel. Une tentative de reconnexion est effectuée toutes les dix minutes et vous serez notifié lorsque nous y parviendrons !", "danger")] }).catch(err => {})

			// Sous-sous commande "add"
			if(interaction.options.getSubcommand() === "add"){
				// Obtenir les arguments
				var name = interaction?.options?.getString("name")
				var number = interaction?.options?.getInteger("number")

				// Defer l'interaction
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// On créé le contact
				var response = await freebox?.client?.fetch({
					method: "POST",
					url: "v10/contact/",
					body: JSON.stringify({
						display_name: name, // Avec son nom uniquement, pour l'instant
					}),
					parseJson: true
				})
				if(!response?.success || !response?.result?.id) return interaction.editReply(`Nous n'avons pas pu créer le contact : ${response?.msg || response?.error?.msg || response?.message || response?.error?.message || JSON.stringify(response)}`).catch(err => {})

				// On ajoute le numéro au contact
				const addNumber = await freebox?.client?.fetch({
					method: "POST",
					url: "v10/number/",
					body: JSON.stringify({
						contact_id: response.result.id,
						number: number, // Lui définir le numéro
					}),
					parseJson: true
				})
				if(!addNumber?.success) return interaction.editReply(`Nous n'avons pas pu ajouter le numéro au contact : ${addNumber?.msg || addNumber?.error?.msg || addNumber?.message || addNumber?.error?.message || JSON.stringify(addNumber)}`).catch(err => {})

				// On répond
				return interaction.editReply(`Le contact **${escape(name)}** a été créé avec succès.`).catch(err => {})
			}

			// Sous-sous commande "delete"
			if(interaction.options.getSubcommand() === "delete"){
				// Defer l'interaction
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// On récupère les contacts
				var response = await freebox?.client?.fetch({
					method: "GET",
					url: "v10/contact/",
					parseJson: true
				})
				if(!response?.success) return interaction.editReply(`Nous n'avons pas pu récupérer les contacts : ${response?.msg || response?.error?.msg || response?.message || response?.error?.message || JSON.stringify(response)}`).catch(err => {})

				// On vérifie qu'on a des contacts
				if(!response?.result?.length) return interaction.editReply("Vous n'avez aucun contact.").catch(err => {})

				// Obtenir le bon contact
				var name = interaction?.options?.getString("name")
				var contacts = response.result.filter(e => e?.display_name?.toLowerCase().trim() == name?.toLowerCase().trim())
				if(!contacts?.length) return interaction.editReply("Nous n'avons pas trouvé de contact pour ce terme de recherche").catch(err => {})

				// On supprime le contact
				var response = await freebox?.client?.fetch({
					method: "DELETE",
					url: `v10/contact/${contacts[0]?.id}`,
					parseJson: true
				})
				if(!response?.success) return interaction.editReply(`Nous n'avons pas pu supprimer le contact : ${response?.msg || response?.error?.msg || response?.message || response?.error?.message || JSON.stringify(response)}`).catch(err => {})

				// On répond
				return interaction.editReply(`Le contact **${escape(name)}** a été supprimé avec succès.`).catch(err => {})
			}

			// Sous-sous commande "show"
			if(interaction.options.getSubcommand() === "show"){
				// Defer l'interaction
				if(await interaction.deferReply().catch(err => { return "stop" }) == "stop") return

				// On récupère les contacts
				var response = await freebox?.client?.fetch({
					method: "GET",
					url: "v10/contact/",
					parseJson: true
				})
				if(!response?.success) return interaction.editReply(`Nous n'avons pas pu récupérer les contacts : ${response?.msg || response?.error?.msg || response?.message || response?.error?.message || JSON.stringify(response)}`).catch(err => {})

				// On vérifie qu'on a des contacts
				if(!response?.result?.length) return interaction.editReply("Vous n'avez aucun contact.").catch(err => {})

				// Obtenir le bon contact
				var name = interaction?.options?.getString("name")
				var contacts = response.result.filter(e => e?.display_name?.toLowerCase().trim() == name?.toLowerCase().trim())
				if(!contacts?.length) return interaction.editReply("Nous n'avons pas trouvé de contact pour ce terme de recherche").catch(err => {})

				// On créé l'embed
				var embed = new EmbedBuilder()
					.setTitle("Freebox Call Notifier — Contact")
					.setColor(bacheroFunctions.colors.primary)

				// On ajoute les champs
				contacts.forEach(e => {
					embed.addFields({ name: e?.display_name, value: e?.numbers?.map(a => escape(a?.number)).join("\n") || "Aucun numéro", inline: true })
				})

				// On répond
				return interaction.editReply({ embeds: [embed] }).catch(err => {})
			}
		}
	}
}
