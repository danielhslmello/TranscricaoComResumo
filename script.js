document.addEventListener("DOMContentLoaded", () => {
    const SAMPLE_RATE = 48000;

    const form = document.querySelector('#form');
    const submitButton = document.querySelector('button[type="submit"]');
    const stopButton = document.querySelector('#stopButton');
    const resultContainer = document.querySelector('#result');
    const micTranscriptContainer = document.querySelector('#mic_transcript');
    const audioTranscriptContainer = document.querySelector('#audio_transcript');
    const partialsContainer = document.querySelector('#partials');
    const micDeviceSelect = document.querySelector('#mic_device');
    const timerContainer = document.querySelector('#timer');
    const summaryContainer = document.querySelector('#summary-container');
    const buttonsContainer = document.querySelector('#buttons-container');
    const extractPointsButton = document.querySelector('#extractPointsButton');
    const extractTodoListButton = document.querySelector('#extractTodoListButton');
    const generateMeetingAgendaButton = document.querySelector('#generateMeetingAgendaButton');
    let startTime, timerInterval;

    async function requestMicrophoneAccess() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
        } catch (error) {
            console.warn('Microphone access was not granted.', error);
        }
    }

    async function listAudioDevices() {
        await requestMicrophoneAccess();
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');

        if (audioInputs.length === 0) {
            window.alert('Nenhum dispositivo de entrada de áudio encontrado. Por favor, verifique as permissões e tente novamente.');
            return;
        }

        micDeviceSelect.innerHTML = audioInputs.map(device => `<option value="${device.deviceId}">${device.label || 'Microfone sem nome'}</option>`).join('');
    }

    function startTimer() {
        startTime = Date.now();
        timerInterval = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            const minutes = Math.floor(elapsedTime / 60000);
            const seconds = Math.floor((elapsedTime % 60000) / 1000);
            timerContainer.textContent = `Duração: ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }, 1000);
    }

    function stopTimer() {
        clearInterval(timerInterval);
    }

    listAudioDevices();

    form.addEventListener('submit', async (evt) => {
        evt.preventDefault();

        const formData = new FormData(form);
        const gladiaKey = formData.get('gladia_key');
        const micDeviceId = formData.get('mic_device');

        submitButton.setAttribute('disabled', 'true');
        submitButton.textContent = 'Aguardando conexão...';
        resultContainer.style.display = 'none';
        micTranscriptContainer.innerHTML = '<h3>Microfone</h3>';
        audioTranscriptContainer.innerHTML = '<h3>Áudio do Sistema</h3>';
        partialsContainer.textContent = '...';

        let micStream, screenStream, micRecorder, audioRecorder, micSocket, audioSocket;

        const stop = async () => {
            submitButton.removeAttribute('disabled');
            submitButton.style.display = 'block';
            submitButton.textContent = 'Iniciar gravação';

            stopButton.setAttribute('disabled', 'true');
            stopButton.style.backgroundColor = '';
            stopButton.style.color = '';
            stopButton.removeEventListener('click', stop);

            micRecorder?.destroy();
            audioRecorder?.destroy();
            micStream?.getTracks().forEach((track) => track.stop());
            screenStream?.getTracks().forEach((track) => track.stop());
            if (micSocket) {
                micSocket.onopen = null;
                micSocket.onerror = null;
                micSocket.onclose = null;
                micSocket.onmessage = null;
                micSocket.close();
            }
            if (audioSocket) {
                audioSocket.onopen = null;
                audioSocket.onerror = null;
                audioSocket.onclose = null;
                audioSocket.onmessage = null;
                audioSocket.close();
            }

            stopTimer();
            await generateSummary(micTranscriptContainer.innerText + audioTranscriptContainer.innerText);
            buttonsContainer.style.display = 'flex';
        };

        try {
            const micSocketPromise = deferredPromise();
            const audioSocketPromise = deferredPromise();

            micSocket = new WebSocket('wss://api.gladia.io/audio/text/audio-transcription');
            micSocket.onopen = () => {
                const configuration = {
                    x_gladia_key: gladiaKey,
                    frames_format: 'bytes',
                    language_behaviour: 'automatic single language',
                    sample_rate: SAMPLE_RATE
                };
                micSocket.send(JSON.stringify(configuration));
            };
            micSocket.onerror = () => {
                micSocketPromise.reject(new Error('Não foi possível conectar ao servidor'));
            };
            micSocket.onclose = (event) => {
                micSocketPromise.reject(new Error(`Conexão recusada pelo servidor: [${event.code}] ${event.reason}`));
            };
            micSocket.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    micSocketPromise.reject(new Error(`Não foi possível analisar a mensagem: ${event.data}`));
                }

                if (data?.event === 'connected') {
                    micSocketPromise.resolve(true);
                } else {
                    micSocketPromise.reject(new Error(`O servidor enviou uma mensagem inesperada: ${event.data}`));
                }
            };

            audioSocket = new WebSocket('wss://api.gladia.io/audio/text/audio-transcription');
            audioSocket.onopen = () => {
                const configuration = {
                    x_gladia_key: gladiaKey,
                    frames_format: 'bytes',
                    language_behaviour: 'automatic single language',
                    sample_rate: SAMPLE_RATE
                };
                audioSocket.send(JSON.stringify(configuration));
            };
            audioSocket.onerror = () => {
                audioSocketPromise.reject(new Error('Não foi possível conectar ao servidor'));
            };
            audioSocket.onclose = (event) => {
                audioSocketPromise.reject(new Error(`Conexão recusada pelo servidor: [${event.code}] ${event.reason}`));
            };
            audioSocket.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    audioSocketPromise.reject(new Error(`Não foi possível analisar a mensagem: ${event.data}`));
                }

                if (data?.event === 'connected') {
                    audioSocketPromise.resolve(true);
                } else {
                    audioSocketPromise.reject(new Error(`O servidor enviou uma mensagem inesperada: ${event.data}`));
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
                audio: true
            });

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const micDestination = audioContext.createMediaStreamDestination();
            const screenDestination = audioContext.createMediaStreamDestination();

            const micSource = audioContext.createMediaStreamSource(micStream);
            micSource.connect(micDestination);

            const screenAudioTrack = screenStream.getAudioTracks()[0];
            if (screenAudioTrack) {
                const screenAudioStream = new MediaStream([screenAudioTrack]);
                const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
                screenSource.connect(screenDestination);
            }

            const combinedMicStream = micDestination.stream;
            const combinedAudioStream = screenDestination.stream;

            micRecorder = new RecordRTC(combinedMicStream, {
                type: 'audio',
                mimeType: 'audio/wav',
                recorderType: RecordRTC.StereoAudioRecorder,
                timeSlice: 1000,
                async ondataavailable(blob) {
                    const buffer = await blob.arrayBuffer();
                    const modifiedBuffer = buffer.slice(44);
                    micSocket?.send(modifiedBuffer);
                },
                sampleRate: SAMPLE_RATE,
                desiredSampRate: SAMPLE_RATE,
                numberOfAudioChannels: 1
            });

            audioRecorder = new RecordRTC(combinedAudioStream, {
                type: 'audio',
                mimeType: 'audio/wav',
                recorderType: RecordRTC.StereoAudioRecorder,
                timeSlice: 1000,
                async ondataavailable(blob) {
                    const buffer = await blob.arrayBuffer();
                    const modifiedBuffer = buffer.slice(44);
                    audioSocket?.send(modifiedBuffer);
                },
                sampleRate: SAMPLE_RATE,
                desiredSampRate: SAMPLE_RATE,
                numberOfAudioChannels: 1
            });

            await Promise.all([micSocketPromise.promise, audioSocketPromise.promise]);
        } catch (err) {
            window.alert(`Erro durante a inicialização: ${err?.message || err}`);
            console.error(err);
            stop();
            return;
        }

        micSocket.onopen = null;
        micSocket.onerror = null;
        micSocket.onclose = (event) => {
            const message = `Conexão perdida com o servidor: [${event.code}] ${event.reason}`;
            window.alert(message);
            console.error(message);
            stop();
        };
        micSocket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data?.event === 'transcript' && data.transcription) {
                if (data.type === 'final') {
                    const correctedText = await correctAndSummarize(data.transcription);
                    micTranscriptContainer.innerHTML += `<p>${correctedText}</p>`;
                    partialsContainer.textContent = '';
                } else {
                    partialsContainer.textContent = data.transcription;
                }
            }
        };

        audioSocket.onopen = null;
        audioSocket.onerror = null;
        audioSocket.onclose = (event) => {
            const message = `Conexão perdida com o servidor: [${event.code}] ${event.reason}`;
            window.alert(message);
            console.error(message);
            stop();
        };
        audioSocket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data?.event === 'transcript' && data.transcription) {
                if (data.type === 'final') {
                    const correctedText = await correctAndSummarize(data.transcription);
                    audioTranscriptContainer.innerHTML += `<p>${correctedText}</p>`;
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

        micRecorder.startRecording();
        audioRecorder.startRecording();
        startTimer();
    });

    function deferredPromise() {
        const deferred = {};
        deferred.promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });
        return deferred;
    }

    async function generateSummary(transcription) {
        try {
            const chatCompletion = await getGroqChatCompletion(transcription);
            const summary = chatCompletion.choices[0]?.message?.content || "";
            displaySummary(summary);
        } catch (error) {
            console.error("Error generating summary:", error);
            window.alert(`Erro ao gerar resumo: ${error.message}`);
        }
    }

    async function getGroqChatCompletion(transcription) {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer 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`
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: "Você é um assistente útil que resume transcrições de áudio."
                    },
                    {
                        role: "user",
                        content: `Resuma a seguinte transcrição de áudio:\n\n${transcription}`
                    }
                ],
                model: "llama3-8b-8192",
                temperature: 0.5,
                max_tokens: 1024,
                top_p: 1,
                stop: null,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Erro na API da Groq: ${response.statusText}`);
        }
        return await response.json();
    }

    async function correctAndSummarize(text) {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer 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`
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: "Você é um assistente útil que corrige e resume transcrições de áudio."
                    },
                    {
                        role: "user",
                        content: `Corrija e resuma a seguinte transcrição de áudio:\n\n${text}`
                    }
                ],
                model: "llama3-8b-8192",
                temperature: 0.5,
                max_tokens: 1024,
                top_p: 1,
                stop: null,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Erro na API da Groq: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0]?.message?.content || "";
    }

    function displaySummary(summary) {
        summaryContainer.innerHTML = `<h2>Resumo</h2><p>${summary}</p>`;
    }

    async function generatePDF(content, title) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 10;
        const textWidth = pageWidth - margin * 2;
        const text = doc.splitTextToSize(content, textWidth);
    
        doc.setFont("times", "normal");
        doc.setFontSize(12);
    
        let cursorY = 20;
    
        doc.text(title, margin, cursorY);
        cursorY += 10;
    
        text.forEach(line => {
            if (cursorY + 10 > pageHeight) { // If text exceeds page height, add new page
                doc.addPage();
                cursorY = 10; // reset cursorY for new page
            }
            doc.text(line, margin, cursorY);
            cursorY += 10;
        });
    
        doc.save(`${title}.pdf`);
    }
    

    extractPointsButton.addEventListener('click', async () => {
        const content = micTranscriptContainer.innerText + audioTranscriptContainer.innerText;
        const points = await extractPoints(content);
        generatePDF(points, 'Pontos Chaves');
    });

    extractTodoListButton.addEventListener('click', async () => {
        const content = micTranscriptContainer.innerText + audioTranscriptContainer.innerText;
        const todoList = await extractTodoList(content);
        generatePDF(todoList, 'Lista de Atividades');
    });

    generateMeetingAgendaButton.addEventListener('click', async () => {
        const content = micTranscriptContainer.innerText + audioTranscriptContainer.innerText;
        const agenda = await generateMeetingAgenda(content);
        generatePDF(agenda, 'Pauta da Reunião');
    });

    async function extractPoints(content) {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer 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`
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: "Você é um assistente útil que extrai pontos chaves de transcrições de áudio."
                    },
                    {
                        role: "user",
                        content: `Extraia os pontos chaves da seguinte transcrição de áudio:\n\n${content}`
                    }
                ],
                model: "llama3-8b-8192",
                temperature: 0.5,
                max_tokens: 1024,
                top_p: 1,
                stop: null,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Erro na API da Groq: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0]?.message?.content || "";
    }

    async function extractTodoList(content) {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer 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`
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: "Você é um assistente útil que extrai listas de atividades de transcrições de áudio."
                    },
                    {
                        role: "user",
                        content: `Extraia a lista de atividades da seguinte transcrição de áudio:\n\n${content}`
                    }
                ],
                model: "llama3-8b-8192",
                temperature: 0.5,
                max_tokens: 1024,
                top_p: 1,
                stop: null,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Erro na API da Groq: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0]?.message?.content || "";
    }

    async function generateMeetingAgenda(content) {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer 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`
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: "Você é um assistente útil que gera pautas de reuniões de transcrições de áudio."
                    },
                    {
                        role: "user",
                        content: `Gere uma pauta da reunião da seguinte transcrição de áudio:\n\n${content}`
                    }
                ],
                model: "llama3-8b-8192",
                temperature: 0.5,
                max_tokens: 1024,
                top_p: 1,
                stop: null,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Erro na API da Groq: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0]?.message?.content || "";
    }
});
