const ytdl = require('@distube/ytdl-core');

// Configuration pour éviter les erreurs de mise à jour
process.env.YTDL_NO_UPDATE = 'true';

// Rate limiting simple (en mémoire)
const requestTracker = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_IP = 5;

export default async function handler(req, res) {
    // Gestion CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        const { url } = req.query;
        const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
        
        if (!url) {
            return res.status(400).json({ 
                error: 'URL manquante. Veuillez fournir une URL YouTube valide.' 
            });
        }

        // Rate limiting basique
        const now = Date.now();
        const clientRequests = requestTracker.get(clientIP) || [];
        const recentRequests = clientRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
        
        if (recentRequests.length >= MAX_REQUESTS_PER_IP) {
            return res.status(429).json({ 
                error: 'Trop de requêtes. Veuillez attendre 1 minute avant de réessayer.' 
            });
        }
        
        recentRequests.push(now);
        requestTracker.set(clientIP, recentRequests);

        // Validation de l'URL YouTube
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ 
                error: 'URL YouTube invalide. Veuillez vérifier l\'URL et réessayer.' 
            });
        }

        console.log(`Début du téléchargement pour: ${url}`);

        // Obtenir les informations de la vidéo avec retry
        let info;
        let retryCount = 0;
        const maxRetries = 2;

        while (retryCount < maxRetries) {
            try {
                // Délai aléatoire pour éviter les requêtes simultanées
                await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
                
                info = await ytdl.getInfo(url, { 
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Accept-Encoding': 'gzip, deflate',
                            'DNT': '1',
                            'Connection': 'keep-alive'
                        },
                        timeout: 20000 // Timeout pour Vercel
                    }
                });
                break;
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw error;
                }
                console.log(`Tentative ${retryCount} échouée (${error.statusCode}), attente...`);
                const delay = error.statusCode === 429 ? 3000 * retryCount : 1500 * retryCount;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        const title = info.videoDetails.title.replace(/[^\w\s-]/gi, '').substring(0, 50);
        
        // Configuration des headers pour le téléchargement
        res.setHeader('Content-Disposition', `attachment; filename="${title || 'video'}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-cache');
        
        // Options optimisées pour Vercel
        const options = {
            quality: 'highestvideo',
            filter: format => format.hasVideo && format.hasAudio && format.container === 'mp4',
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://www.youtube.com/',
                    'DNT': '1',
                    'Connection': 'keep-alive'
                },
                timeout: 20000
            }
        };

        // Si pas de format avec vidéo+audio, prendre le meilleur format disponible
        const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
        if (formats.length === 0) {
            options.quality = 'highest';
            delete options.filter;
        }

        // Créer le stream de téléchargement
        const videoStream = ytdl(url, options);
        
        // Gestion des erreurs du stream
        videoStream.on('error', (error) => {
            console.error('Erreur du stream vidéo:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: `Erreur lors du streaming: ${error.message}` });
            }
        });

        // Gestion du début du stream
        videoStream.on('response', (response) => {
            console.log('Stream démarré, taille:', response.headers['content-length']);
        });

        // Gestion de la progression
        videoStream.on('progress', (chunkLength, downloaded, total) => {
            const percent = (downloaded / total * 100).toFixed(2);
            console.log(`Progression: ${percent}%`);
        });

        // Pipe du stream vers la réponse
        videoStream.pipe(res);

        // Gestion de la fin du téléchargement
        videoStream.on('end', () => {
            console.log('Téléchargement terminé avec succès');
        });

        // Gestion de la fermeture de la connexion client
        req.on('close', () => {
            console.log('Connexion fermée par le client');
            if (videoStream && !videoStream.destroyed) {
                videoStream.destroy();
            }
        });

    } catch (error) {
        console.error('Erreur lors du téléchargement:', error);
        
        if (!res.headersSent) {
            if (error.message.includes('Video unavailable') || error.statusCode === 410) {
                res.status(404).json({ 
                    error: 'Vidéo non disponible. Elle pourrait être privée, supprimée, géo-bloquée ou temporairement inaccessible.' 
                });
            } else if (error.message.includes('age-restricted')) {
                res.status(403).json({ 
                    error: 'Cette vidéo a une restriction d\'âge et ne peut pas être téléchargée.' 
                });
            } else if (error.statusCode === 403) {
                res.status(403).json({ 
                    error: 'Accès refusé. La vidéo pourrait avoir des restrictions de téléchargement.' 
                });
            } else if (error.statusCode === 429) {
                res.status(429).json({ 
                    error: 'Trop de requêtes vers YouTube. Veuillez attendre quelques minutes et réessayer.' 
                });
            } else {
                res.status(500).json({ 
                    error: `Erreur lors du téléchargement: ${error.message}` 
                });
            }
        }
    }
}
