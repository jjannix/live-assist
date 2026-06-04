if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
        .then(reg => console.log('SW registered', reg))
        .catch(err => console.log('SW failed', err));
}

// Register as PWA manifest
const link = document.createElement('link');
link.rel = 'manifest';
link.href = '/manifest.json';
document.head.appendChild(link);
