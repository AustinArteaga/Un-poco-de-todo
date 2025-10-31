// Configuración del webhook (oculto en el código)
const WEBHOOK_URL = 'https://n8n.srv1064373.hstgr.cloud/webhook/944c8213-5663-4f7e-aaa7-167478ef7602';

// Referencias a elementos del DOM
const form = document.getElementById('contactForm');
const messageDiv = document.getElementById('message');
const submitBtn = document.getElementById('submitBtn');
const loader = document.getElementById('loader');

/**
 * Muestra un mensaje al usuario
 * @param {string} text - Texto del mensaje
 * @param {string} type - Tipo de mensaje ('success' o 'error')
 */
function showMessage(text, type) {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    // Ocultar mensaje después de 5 segundos
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 5000);
}

/**
 * Cambia el estado del botón durante el envío
 * @param {boolean} isLoading - Si está cargando o no
 */
function setLoadingState(isLoading) {
    if (isLoading) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Enviando... <span class="loader"></span>';
    } else {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Enviar mensaje';
    }
}

/**
 * Valida el formato de un email
 * @param {string} email - Email a validar
 * @returns {boolean} - True si es válido
 */
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Obtiene la fecha y hora actual en formato ISO
 * @returns {string} - Fecha en formato ISO
 */
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * Limpia y sanitiza un string
 * @param {string} str - String a limpiar
 * @returns {string} - String limpio
 */
function sanitizeInput(str) {
    if (!str) return '';
    return str.trim();
}

/**
 * Recopila los datos del formulario
 * @returns {object} - Objeto con los datos del formulario
 */
function getFormData() {
    return {
        nombre: sanitizeInput(document.getElementById('nombre').value),
        email: sanitizeInput(document.getElementById('email').value),
        telefono: sanitizeInput(document.getElementById('telefono').value),
        asunto: document.getElementById('asunto').value,
        mensaje: sanitizeInput(document.getElementById('mensaje').value),
        timestamp: getCurrentTimestamp(),
        origen: 'Formulario Web'
    };
}

/**
 * Envía los datos al webhook de n8n
 * @param {object} formData - Datos del formulario
 * @returns {Promise} - Promesa con la respuesta
 */
async function sendToWebhook(formData) {
    const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData)
    });
    
    if (!response.ok) {
        throw new Error(`Error del servidor: ${response.status}`);
    }
    
    return response;
}

/**
 * Maneja el envío del formulario
 * @param {Event} e - Evento del formulario
 */
async function handleSubmit(e) {
    e.preventDefault();
    
    // Recopilar datos del formulario
    const formData = getFormData();
    
    // Validaciones adicionales
    if (!isValidEmail(formData.email)) {
        showMessage('❌ Por favor, ingresa un email válido', 'error');
        return;
    }
    
    if (formData.nombre.length < 2) {
        showMessage('❌ El nombre debe tener al menos 2 caracteres', 'error');
        return;
    }
    
    if (formData.mensaje.length < 10) {
        showMessage('❌ El mensaje debe tener al menos 10 caracteres', 'error');
        return;
    }
    
    // Mostrar estado de carga
    setLoadingState(true);
    
    try {
        // Enviar datos a n8n
        await sendToWebhook(formData);
        
        // Mostrar mensaje de éxito
        showMessage('✅ ¡Mensaje enviado exitosamente! Nos pondremos en contacto pronto.', 'success');
        
        // Limpiar formulario
        form.reset();
        
        // Log para desarrollo (eliminar en producción)
        console.log('Formulario enviado:', formData);
        
    } catch (error) {
        console.error('Error al enviar:', error);
        showMessage('❌ Error al enviar el mensaje. Por favor, intenta nuevamente.', 'error');
    } finally {
        setLoadingState(false);
    }
}

/**
 * Valida un campo en tiempo real
 * @param {HTMLElement} field - Campo a validar
 */
function validateField(field) {
    const value = field.value.trim();
    
    // Validar email
    if (field.type === 'email' && value) {
        if (!isValidEmail(value)) {
            field.classList.add('error');
        } else {
            field.classList.remove('error');
        }
    }
    
    // Validar campos requeridos
    if (field.hasAttribute('required') && !value) {
        field.classList.add('error');
    } else {
        field.classList.remove('error');
    }
}

/**
 * Inicializa event listeners
 */
function initEventListeners() {
    // Envío del formulario
    form.addEventListener('submit', handleSubmit);
    
    // Validación en tiempo real del email
    const emailInput = document.getElementById('email');
    emailInput.addEventListener('blur', function() {
        validateField(this);
    });
    
    // Remover clase de error al empezar a escribir
    const inputs = form.querySelectorAll('input, textarea, select');
    inputs.forEach(input => {
        input.addEventListener('input', function() {
            this.classList.remove('error');
        });
    });
    
    // Validación de campos requeridos al perder foco
    inputs.forEach(input => {
        if (input.hasAttribute('required')) {
            input.addEventListener('blur', function() {
                validateField(this);
            });
        }
    });
}

/**
 * Función de inicialización
 */
function init() {
    console.log('Formulario de contacto inicializado');
    initEventListeners();
    
    // Verificar que el webhook esté configurado
    if (!WEBHOOK_URL) {
        console.error('ERROR: Webhook URL no configurada');
        showMessage('❌ Error de configuración. Por favor contacta al administrador.', 'error');
    }
}

// Inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Prevenir pérdida de datos si el usuario intenta salir con el formulario lleno
window.addEventListener('beforeunload', function(e) {
    const formData = getFormData();
    const hasData = formData.nombre || formData.email || formData.mensaje;
    
    if (hasData && !form.dataset.submitted) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Marcar formulario como enviado
form.addEventListener('submit', function() {
    this.dataset.submitted = 'true';
});
