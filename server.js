import express from 'express';
import ytdl from '@distube/ytdl-core';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuration ES6 pour __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration pour éviter les erreurs de mise à jour
process.env.YTDL_NO_UPDATE = 'true';

const app = express();

// Middleware pour gérer CORS (Vercel)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Rate limiting simple (en mémoire pour Vercel)
const requestTracker = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_IP = 5; // Plus permissif sur Vercel

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware pour servir les fichiers statiques (pour développement local)
if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(path.join(__dirname)));
}

// Route principale - servir index.html (Vercel gère automatiquement)
app.get('/', (req, res) => {
    if (process.env.VERCEL) {
        // Sur Vercel, rediriger vers le fichier statique
        res.redirect('/index.html');
    } else {
        // En local
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// Route de téléchargement
app.get('/download', async (req, res) => {
    try {
        const url = req.query.url;
        const clientIP = req.ip || req.connection.remoteAddress;
        
        if (!url) {
            return res.status(400).send('URL manquante. Veuillez fournir une URL YouTube valide.');
        }

        // Rate limiting basique
        const now = Date.now();
        const clientRequests = requestTracker.get(clientIP) || [];
        const recentRequests = clientRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
        
        if (recentRequests.length >= MAX_REQUESTS_PER_IP) {
            return res.status(429).send('Trop de requêtes. Veuillez attendre 1 minute avant de réessayer.');
        }
        
        recentRequests.push(now);
        requestTracker.set(clientIP, recentRequests);

        // Validation de l'URL YouTube
        if (!ytdl.validateURL(url)) {
            return res.status(400).send('URL YouTube invalide. Veuillez vérifier l\'URL et réessayer.');
        }

        console.log(`Début du téléchargement pour: ${url}`);

        // Obtenir les informations de la vidéo avec retry et délais
        let info;
        let retryCount = 0;
        const maxRetries = 2; // Réduit pour éviter d'aggraver le rate limiting

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
                        timeout: 25000 // Timeout plus court pour Vercel
                    }
                });
                break;
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw error;
                }
                console.log(`Tentative ${retryCount} échouée (${error.statusCode}), attente...`);
                // Délai croissant mais plus court pour Vercel
                const delay = error.statusCode === 429 ? 5000 * retryCount : 2000 * retryCount;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        const title = info.videoDetails.title.replace(/[^\w\s-]/gi, '').substring(0, 50);
        
        // Configuration des headers pour le téléchargement
        res.setHeader('Content-Disposition', `attachment; filename="${title || 'video'}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        
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
                timeout: 25000 // Timeout adapté à Vercel
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
                res.status(500).send(`Erreur lors du streaming: ${error.message}`);
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
                res.status(404).send('Vidéo non disponible. Elle pourrait être privée, supprimée, géo-bloquée ou temporairement inaccessible.');
            } else if (error.message.includes('age-restricted')) {
                res.status(403).send('Cette vidéo a une restriction d\'âge et ne peut pas être téléchargée.');
            } else if (error.statusCode === 403) {
                res.status(403).send('Accès refusé. La vidéo pourrait avoir des restrictions de téléchargement.');
            } else if (error.statusCode === 429) {
                res.status(429).send('Trop de requêtes vers YouTube. Veuillez attendre quelques minutes et réessayer. YouTube limite le nombre de téléchargements.');
            } else {
                res.status(500).send(`Erreur lors du téléchargement: ${error.message}`);
            }
        }
    }
});

// Route de santé pour Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Middleware de gestion d'erreur globale
app.use((error, req, res, next) => {
    console.error('Erreur non gérée:', error);
    res.status(500).send('Erreur interne du serveur');
});

// Middleware pour les routes non trouvées
app.use((req, res) => {
    res.status(404).send('Page non trouvée');
});

// Nettoyage périodique du rate limiting (seulement en local)
if (!process.env.VERCEL) {
    setInterval(() => {
        const now = Date.now();
        for (const [ip, requests] of requestTracker.entries()) {
            const recentRequests = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
            if (recentRequests.length === 0) {
                requestTracker.delete(ip);
            } else {
                requestTracker.set(ip, recentRequests);
            }
        }
    }, RATE_LIMIT_WINDOW);
}

// Export pour Vercel ou démarrage serveur pour local
if (process.env.VERCEL) {
    export default app;
} else {
    // Démarrage du serveur pour développement local
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Serveur démarré sur le port ${PORT}`);
        console.log(`📱 Application disponible sur: http://localhost:${PORT}`);
        console.log(`🎥 Prêt à télécharger des vidéos YouTube !`);
    });
}
