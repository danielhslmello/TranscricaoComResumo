document.addEventListener("DOMContentLoaded", () => {
    const SAMPLE_RATE = 48000;

    const form = document.querySelector('#form');
    const submitButton = document.querySelector('button[type="submit"]');
    const stopButton = document.querySelector('#stopButton');
    const resultContainer = document.querySelector('#result');
    const finalsContainer = document.querySelector('#finals');
    const partialsContainer = document.querySelector('#partials');
    const micDeviceSelect = document.querySelector('#mic_device');
    const audioDeviceSelect = document.querySelector('#audio_device');

    async function listAudioDevices() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        const audioOutputs = devices.filter(device => device.kind === 'audiooutput');

        micDeviceSelect.innerHTML = audioInputs.map(device => `<option value="${device.deviceId}">${device.label}</option>`).join('');
        audioDeviceSelect.innerHTML = audioOutputs.map(device => `<option value="${device.deviceId}">${device.label}</option>`).join('');
    }

    listAudioDevices();

    form.addEventListener('submit', async (evt) => {
        evt.preventDefault();

        const formData = new FormData(form);
        const gladiaKey = formData.get('gladia_key');
        const micDeviceId = formData.get('mic_device');
        const audioDeviceId = formData.get('audio_device');

        submitButton.setAttribute('disabled', 'true');
        submitButton.textContent = 'Aguardando conexão...';
        resultContainer.style.display = 'none';
        finalsContainer.textContent = '';
        partialsContainer.textContent = '...';

        let micStream, screenStream, combinedStream, recorder, socket;

        const stop = async () => {
            submitButton.removeAttribute('disabled');
            submitButton.style.display = 'block';
            submitButton.textContent = 'Iniciar gravação';

            stopButton.setAttribute('disabled', 'true');
            stopButton.style.backgroundColor = '';
            stopButton.style.color = '';
            stopButton.removeEventListener('click', stop);

            recorder?.destroy();
            micStream?.getTracks().forEach((track) => track.stop());
            screenStream?.getTracks().forEach((track) => track.stop());
            if (socket) {
                socket.onopen = null;
                socket.onerror = null;
                socket.onclose = null;
                socket.onmessage = null;
                socket.close();
            }
        };

        try {
            const socketPromise = deferredPromise();

            socket = new WebSocket('wss://api.gladia.io/audio/text/audio-transcription');
            socket.onopen = () => {
                const configuration = {
                    x_gladia_key: gladiaKey,
                    frames_format: 'bytes',
                    language_behaviour: 'automatic single language',
                    sample_rate: SAMPLE_RATE
                };
                socket.send(JSON.stringify(configuration));
            };
            socket.onerror = () => {
                socketPromise.reject(new Error('Não foi possível conectar ao servidor'));
            };
            socket.onclose = (event) => {
                socketPromise.reject(new Error(`Conexão recusada pelo servidor: [${event.code}] ${event.reason}`));
            };
            socket.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    socketPromise.reject(new Error(`Não foi possível analisar a mensagem: ${event.data}`));
                }

                if (data?.event === 'connected') {
                    socketPromise.resolve(true);
                } else {
                    socketPromise.reject(new Error(`O servidor enviou uma mensagem inesperada: ${event.data}`));
                }
            };

            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: SAMPLE_RATE
                }
            });

            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined
                }
            });

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const destination = audioContext.createMediaStreamDestination();

            const micSource = audioContext.createMediaStreamSource(micStream);
            micSource.connect(destination);

            const screenAudioTrack = screenStream.getAudioTracks()[0];
            if (screenAudioTrack) {
                const screenAudioStream = new MediaStream([screenAudioTrack]);
                const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
                screenSource.connect(destination);
            }

            combinedStream = destination.stream;

            recorder = new RecordRTC(combinedStream, {
                type: 'audio',
                mimeType: 'audio/wav',
                recorderType: RecordRTC.StereoAudioRecorder,
                timeSlice: 1000,
                async ondataavailable(blob) {
                    const buffer = await blob.arrayBuffer();
                    const modifiedBuffer = buffer.slice(44);
                    socket?.send(modifiedBuffer);
                },
                sampleRate: SAMPLE_RATE,
                desiredSampRate: SAMPLE_RATE,
                numberOfAudioChannels: 1
            });

            await socketPromise.promise;
        } catch (err) {
            window.alert(`Erro durante a inicialização: ${err?.message || err}`);
            console.error(err);
            stop();
            return;
        }

        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = (event) => {
            const message = `Conexão perdida com o servidor: [${event.code}] ${event.reason}`;
            window.alert(message);
            console.error(message);
            stop();
        };
        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data?.event === 'transcript' && data.transcription) {
                if (data.type === 'final') {
                    finalsContainer.textContent += data.transcription;
                    partialsContainer.textContent = '';
                } else {
                    partialsContainer.textContent = data.transcription;
                }
            }
        };

        submitButton.textContent = 'Gravando...';

        stopButton.removeAttribute('disabled');
        stopButton.style.backgroundColor = '#d94242';
        stopButton.style.color = '#fff';
        stopButton.addEventListener('click', stop);

        resultContainer.style.display = 'block';

        recorder.startRecording();
    });

    function deferredPromise() {
        const deferred = {};
        deferred.promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });
        return deferred;
    }
});
